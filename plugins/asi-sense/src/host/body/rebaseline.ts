import type { BodyEvaluation, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import type { AnomalyRule } from './anomaly.ts';
import { formatter, slotOf } from './baseline-time.ts';
import {
  build,
  type Candidate,
  candidateId,
  decode,
  encode,
  keyOf,
  metricState,
  paramOf,
  pruneSuggestions,
  sampleCount,
  withBaseline,
  withMetricState,
} from './rebaseline-candidate.ts';
import { detectCandidates } from './rebaseline-detect.ts';
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
  key: string;
  undo: Omit<Undo, 'id'>;
  resultState: AdaptiveState;
}

export interface RebaselineSuggestion {
  id: string;
  stream: string;
  metric: string;
  slot: number;
  from: number;
  to: number;
  samples: number;
  dates: number;
}

export interface RebaselineStage {
  state: AdaptiveState;
  snapshot: RebaselineSnapshot;
}

export class RebaselineManager {
  private candidates = new Map<string, Candidate>();
  private undos: Undo[] = [];
  private pending?: Context;
  private watermarks = new Map<string, number>();
  private active = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly tuner: Tuner,
    private readonly rules: readonly AnomalyRule[],
    private readonly current: () => AdaptiveState | undefined,
    private readonly clock: () => number,
    private readonly wallClock: () => number,
  ) {
    tuner.setRebaselineHost(this);
  }

  get inTransaction(): boolean {
    return this.pending !== undefined;
  }

  onSynchronousSample(): void {
    if (this.active) return;
    this.candidates.clear();
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
    pruneSuggestions(this.candidates, this.current(), this.clock(), this.wallClock());
    return {
      candidates: [...this.candidates.values()].map(({ lastMono: _lastMono, ...candidate }) => candidate),
      undos: this.undos.map((entry) => ({ ...entry })),
    };
  }

  run(
    next: BodyThresholdSample,
    previous: BodyThresholdState,
    evaluate: () => BodyEvaluation,
    commit?: (result: AutomaticBodyEvaluation) => void,
  ): Promise<AutomaticBodyEvaluation> {
    return this.enqueue(async () => {
      const last = this.watermarks.get(next.source.id);
      if (last !== undefined && next.monotonicAt <= last) {
        const result = { signals: [], state: this.current() ?? previous };
        commit?.(result);
        return result;
      }
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
      const evaluated = {
        ...result,
        signals: [
          ...result.signals,
          ...detectCandidates(next, result.state as AdaptiveState, this.rules, this.candidates),
        ],
      };
      commit?.(evaluated);
      return evaluated;
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
    pruneSuggestions(this.candidates, state, this.clock(), this.wallClock());
    return true;
  }

  get suggestions(): RebaselineSuggestion[] {
    const state = this.current();
    pruneSuggestions(this.candidates, state, this.clock(), this.wallClock());
    return [...this.candidates.values()].flatMap((candidate) => {
      const baseline = state?.[BODY_HISTORY]?.[candidate.stream]?.anomaly?.baseline;
      const old = baseline?.bucket(candidate.metric, candidate.slot);
      if (!candidate.suggested || !baseline || !old) return [];
      return [
        {
          id: candidateId(candidate),
          stream: candidate.stream,
          metric: candidate.metric,
          slot: candidate.slot,
          from: old.mean,
          to: build(candidate, baseline.scaleMinimum(candidate.metric)).mean,
          samples: sampleCount(candidate),
          dates: candidate.days.length,
        },
      ];
    });
  }

  accept(id: string): Promise<TuningResult> {
    return this.enqueue(async () => {
      pruneSuggestions(this.candidates, this.current(), this.clock(), this.wallClock());
      const candidate = [...this.candidates.values()].find((entry) => entry.suggested && candidateId(entry) === id);
      const state = this.current();
      const baseline = candidate && state?.[BODY_HISTORY]?.[candidate.stream]?.anomaly?.baseline;
      const old = candidate && baseline?.bucket(candidate.metric, candidate.slot);
      if (!candidate || !state || !baseline || !old) throw new Error('rebaseline: unknown or expired suggestion');
      const revised = baseline.clone();
      const replacement = build(candidate, baseline.scaleMinimum(candidate.metric));
      revised.replace(candidate.metric, candidate.slot, replacement);
      const rules = this.rules.filter((r) => r.metric === candidate.metric);
      const previous = metricState(state, candidate.stream, rules);
      const current = structuredClone(previous);
      const sample = candidate.latest ?? candidate.days.at(-1)?.samples.at(-1);
      const stat = sample && revised.read(candidate.metric, sample.at);
      if (sample && stat && slotOf(formatter(sample.zone), sample.at).index === candidate.slot)
        for (const rule of rules) {
          const sigma = rule.param ? this.tuner.number(rule.param, rule.sigma ?? 3) : (rule.sigma ?? 3);
          const deviation = Math.abs(sample.value - stat.mean) / stat.scale;
          const k = sigma * (2 - stat.confidence);
          current.streaks[rule.id] = deviation > k ? Math.max(1, current.streaks[rule.id]) : 0;
          const key = `baseline:${rule.id}`;
          const active =
            current.streaks[rule.id] >= (rule.consecutive ?? 3) ||
            (previous.latch[key] === 'warn' && deviation >= 0.8 * k);
          current.latch[key] = active ? 'warn' : 'normal';
        }
      const param = paramOf(candidate.stream, candidate.metric, candidate.slot);
      const undo = {
        param,
        stream: candidate.stream,
        metric: candidate.metric,
        slot: candidate.slot,
        backup: encode(old),
        previous,
      };
      const resultState = withMetricState(withBaseline(state, candidate.stream, revised), candidate.stream, current);
      const context = {
        state,
        key: keyOf(candidate.stream, candidate.metric, candidate.slot),
        undo,
        resultState,
      };
      this.pending = context;
      try {
        return await this.tuner.rebaseline(this, param, old.mean, replacement.mean, context);
      } finally {
        this.pending = undefined;
      }
    });
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
      key: keyOf(undo.stream, undo.metric, undo.slot),
      undo: {
        ...undo,
        backup: encode(old),
        previous: metricState(
          state,
          undo.stream,
          this.rules.filter((r) => r.metric === undo.metric),
        ),
      },
      resultState: withMetricState(
        withBaseline(state, undo.stream, revised),
        undo.stream,
        undo.previous ??
          metricState(
            state,
            undo.stream,
            this.rules.filter((r) => r.metric === undo.metric),
          ),
      ),
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
    return { state: c.resultState, snapshot };
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
