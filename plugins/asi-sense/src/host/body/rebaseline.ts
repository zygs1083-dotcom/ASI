import type { BodyEvaluation, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import type { AnomalyRule } from './anomaly.ts';
import { BASELINE_MIN_COUNT, BASELINE_MIN_DATES, type Baseline } from './baseline.ts';
import { formatter, slotOf } from './baseline-time.ts';
import { readMetrics } from './metrics.ts';
import {
  build,
  type Candidate,
  clearMetric,
  decode,
  encode,
  keyOf,
  paramOf,
  record,
  withBaseline,
} from './rebaseline-candidate.ts';
import { restoreProgress, type Undo } from './rebaseline-restore.ts';
import { type AdaptiveState, BODY_HISTORY } from './state.ts';
import type { Tuner, TuningResult } from './tuner.ts';

export interface RebaselineSnapshot {
  candidates: Omit<Candidate, 'lastMono'>[];
  undos: Undo[];
}

export interface AutomaticBodyEvaluation extends BodyEvaluation {
  tuningError?: unknown;
}

interface Context {
  state: AdaptiveState;
  revised: Baseline;
  key: string;
  undo: Omit<Undo, 'id'>;
}

export interface RebaselineStage {
  state: AdaptiveState;
  snapshot: RebaselineSnapshot;
}

export class RebaselineManager {
  private candidates = new Map<string, Candidate>();
  private undos: Undo[] = [];
  private pending?: Context;
  private retry = new Map<string, number>();
  private watermarks = new Map<string, number>();
  private active = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly tuner: Tuner,
    private readonly rules: readonly AnomalyRule[],
    private readonly current: () => AdaptiveState | undefined,
  ) {
    tuner.setRebaselineHost(this);
  }

  get inTransaction(): boolean {
    return this.pending !== undefined;
  }

  onSynchronousSample(): void {
    if (this.active) return;
    this.candidates.clear();
    this.retry.clear();
    this.watermarks.clear();
  }

  revertChange(id: string): Promise<TuningResult> {
    return this.enqueue(() => {
      const state = this.current();
      if (!state) throw new Error('rebaseline: no current state');
      return this.revert(id, state);
    });
  }

  snapshot(): RebaselineSnapshot {
    return {
      candidates: [...this.candidates.values()].map(({ lastMono: _lastMono, ...candidate }) => candidate),
      undos: this.undos.map((entry) => ({ ...entry })),
    };
  }

  run(
    next: BodyThresholdSample,
    previous: BodyThresholdState,
    evaluate: () => BodyEvaluation,
  ): Promise<AutomaticBodyEvaluation> {
    return this.enqueue(async () => {
      const last = this.watermarks.get(next.source.id);
      if (last !== undefined && next.monotonicAt <= last) return { signals: [], state: this.current() ?? previous };
      const current = this.current();
      if (current && previous !== current) throw new Error('monitor: stale adaptive state');
      this.active = true;
      let result: BodyEvaluation;
      try {
        result = evaluate();
      } finally {
        this.active = false;
      }
      this.watermarks.set(next.source.id, next.monotonicAt);
      try {
        return { ...result, state: await this.evaluate(next, result.state as AdaptiveState) };
      } catch (tuningError) {
        if (this.tuner.tuningDisabled !== 'storage-failed') throw tuningError;
        return { ...result, state: this.current() ?? result.state, tuningError };
      }
    });
  }

  settle(): Promise<void> {
    return this.tail;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(run);
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  restore(raw: unknown, state: AdaptiveState): boolean {
    const restored = restoreProgress(raw, state, this.tuner, this.rules);
    if (!restored) return false;
    this.candidates = restored.candidates;
    this.undos = restored.undos;
    return true;
  }

  async evaluate(next: BodyThresholdSample, initial: AdaptiveState): Promise<AdaptiveState> {
    let state = initial;
    const metrics = readMetrics(next);
    const seen = new Set<string>();
    for (const rule of this.rules) {
      if (seen.has(rule.metric)) continue;
      seen.add(rule.metric);
      const history = state[BODY_HISTORY]?.[next.source.id]?.anomaly;
      const baseline = history?.baseline;
      const value = metrics.get(rule.metric)?.value;
      const stat = value === undefined ? undefined : baseline?.read(rule.metric, next.at);
      if (
        !baseline ||
        value === undefined ||
        !stat ||
        history.lastAt !== next.monotonicAt ||
        stat.count < BASELINE_MIN_COUNT ||
        stat.dates < BASELINE_MIN_DATES
      )
        continue;
      const zone = baseline.timeZone;
      const local = slotOf(formatter(zone), next.at);
      const key = keyOf(next.source.id, rule.metric, local.index);
      const deviation = Math.abs(value - stat.mean) / stat.scale;
      const breaches = this.rules.filter((candidate) => {
        if (candidate.metric !== rule.metric) return false;
        const fallback = candidate.sigma ?? 3;
        const resolved = candidate.param ? this.tuner.number(candidate.param, fallback) : fallback;
        const sigma = Number.isFinite(resolved) && resolved > 0 ? resolved : fallback;
        return deviation > sigma * (2 - stat.confidence);
      });
      if (!breaches.some((candidate) => history.latch[`baseline:${candidate.id}`] === 'warn')) {
        if (breaches.length === 0) clearMetric(this.candidates, this.retry, next.source.id, rule.metric);
        continue;
      }
      let candidate = this.candidates.get(key);
      if (!candidate) {
        if (this.candidates.size >= 1024) {
          const first = this.candidates.keys().next().value;
          if (first !== undefined) {
            this.candidates.delete(first);
            this.retry.delete(first);
          }
        }
        candidate = { stream: next.source.id, metric: rule.metric, slot: local.index, days: [] };
        this.candidates.set(key, candidate);
      }
      if (!record(candidate, local.date, baseline.elapsed, next.monotonicAt, { at: next.at, value, zone })) continue;
      if (candidate.days.length < 3 || next.monotonicAt < (this.retry.get(key) ?? Number.NEGATIVE_INFINITY)) continue;
      const old = baseline.bucket(rule.metric, local.index);
      if (!old) continue;
      const revised = baseline.clone();
      const replacement = build(candidate, baseline.scaleMinimum(rule.metric));
      revised.replace(rule.metric, local.index, replacement);
      const param = paramOf(candidate.stream, candidate.metric, candidate.slot);
      const undo = {
        param,
        stream: candidate.stream,
        metric: candidate.metric,
        slot: candidate.slot,
        backup: encode(old),
      };
      const context = { state, revised, key, undo };
      this.pending = context;
      try {
        const result = await this.tuner.rebaseline(this, param, old.mean, replacement.mean, context);
        if (result.applied) {
          this.retry.delete(key);
          state = this.current() ?? withBaseline(state, candidate.stream, revised);
        } else this.retry.set(key, next.monotonicAt + 3_600_000);
      } finally {
        this.pending = undefined;
      }
    }
    return state;
  }

  async revert(id: string, state: AdaptiveState): Promise<TuningResult> {
    const undo = this.undos.find((entry) => entry.id === id);
    const change = this.tuner.undoableChanges.find((entry) => entry.id === id);
    if (!undo || !change) throw new Error('no undoable rebaseline with that id');
    const baseline = state[BODY_HISTORY]?.[undo.stream]?.anomaly?.baseline;
    const old = baseline?.bucket(undo.metric, undo.slot);
    if (!baseline || !old) throw new Error('rebaseline: missing current bucket');
    const revised = baseline.clone();
    const replacement = decode(undo.backup, undo.slot);
    revised.replace(undo.metric, undo.slot, replacement);
    const context = {
      state,
      revised,
      key: keyOf(undo.stream, undo.metric, undo.slot),
      undo: { ...undo, backup: encode(old) },
    };
    this.pending = context;
    try {
      return await this.tuner.rebaseline(this, undo.param, old.mean, replacement.mean, context, id);
    } finally {
      this.pending = undefined;
    }
  }

  stage(context: unknown, result: unknown): RebaselineStage {
    if (context !== this.pending || !context || !result || typeof result !== 'object') {
      throw new TypeError('rebaseline: invalid transaction');
    }
    const c = context as Context;
    const outcome = result as TuningResult;
    if (!outcome.applied) return { state: c.state, snapshot: this.snapshot() };
    const snapshot = this.snapshot();
    snapshot.candidates = snapshot.candidates.filter((item) => keyOf(item.stream, item.metric, item.slot) !== c.key);
    snapshot.undos = snapshot.undos.filter((item) => item.param !== c.undo.param);
    snapshot.undos.push({ ...c.undo, id: outcome.change.id });
    return { state: withBaseline(c.state, c.undo.stream, c.revised), snapshot };
  }

  publish(stage: RebaselineStage): AdaptiveState {
    const previous = this.candidates;
    this.candidates = new Map(
      stage.snapshot.candidates.map((item) => {
        const key = keyOf(item.stream, item.metric, item.slot);
        return [key, { ...item, lastMono: previous.get(key)?.lastMono }];
      }),
    );
    this.undos = stage.snapshot.undos;
    return stage.state;
  }
}
