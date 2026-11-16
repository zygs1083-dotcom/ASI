import type {
  BodyEvaluation,
  BodyEvaluator,
  BodyThresholdSample,
  BodyThresholdState,
  Signal,
  ThresholdSeverity,
} from '@asi/sense-types';
import { FloorEvaluator } from '../attention/thresholds.ts';
import { AnomalyEvaluator, type AnomalyRule } from './anomaly.ts';
import { Baseline, type BaselineOptions } from './baseline.ts';
import { FileBurstDetector, type FileBurstOptions } from './burst.ts';
import type { BodySignal } from './metrics.ts';
import { type BodyPersistence, PersistScheduler } from './persistence.ts';
import { RateEvaluator, type RateRule } from './rate.ts';
import { defaultAnomalyRules, defaultRateRules, floorTable } from './rules.ts';
import { type AdaptiveState, BODY_HISTORY, parseHistory, serializeHistory } from './state.ts';
import type { Tuner } from './tuner.ts';

export interface BodyMonitorOptions {
  /** Injected MONOTONIC clock; stamped onto samples as `monotonicAt`. */
  clock?: () => number;
  /** Wall clock for the baseline seed + persistence bookkeeping. */
  wallClock?: () => number;
  /** IANA zone for baseline buckets; default the runtime's local zone. */
  timeZone?: string;
  /** Immutable anomaly seed; a restore replaces it wholesale. */
  baseline?: Baseline;
  /** Default built-ins; an explicit array overrides — `[]` disables the layer. */
  rateRules?: readonly RateRule[];
  anomalyRules?: readonly AnomalyRule[];
  tuner?: Tuner;
  /** Combined tuner+baseline+state snapshot store (one file, atomic writes). */
  persistence?: BodyPersistence;
  /** Options for the always-on built-in burst detector (e.g. watched `roots`). */
  fileBurst?: FileBurstOptions;
}

const BAD = '\x00invalid';

/**
 * Composes the four §2.2c layers behind one {@link BodyEvaluator}: the M1
 * floor (tuner values read directly — user loosenings honored, AI can only
 * tighten), {@link RateEvaluator} on monotonic windows, {@link AnomalyEvaluator}
 * on the seeded baseline, and a built-in {@link FileBurstDetector} fed by
 * {@link accept} so file deletions can never slip through unmonitored.
 * Samples are stamped with the injected monotonic clock (a supplied
 * `monotonicAt` is respected); `prev`'s stamp derives from the wall gap
 * capped at the largest rule window. Adaptive state lives in caller-threaded
 * {@link BODY_HISTORY} metadata; the monitor keeps the latest returned state
 * for persistence only, never for detection.
 */
export class BodyMonitor implements BodyEvaluator {
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly timeZone?: string;
  private readonly tuner?: Tuner;
  private readonly rate?: RateEvaluator;
  private readonly anomalyRules?: readonly AnomalyRule[];
  private readonly burst: FileBurstDetector;
  private readonly persistence?: BodyPersistence;
  private readonly scheduler?: PersistScheduler;
  private readonly maxRateWindow: number;
  private seed: Baseline;
  private anomaly?: AnomalyEvaluator;
  private latest?: AdaptiveState;
  private restored = false;
  /** Saves stay blocked until {@link restore} settles — never overwrite the stored snapshot first. */
  private persistReady: boolean;
  /** Monitor-level kill switch, independent of a wired tuner. */
  tuningDisabled: 'restore-failed' | undefined;

  constructor(options: BodyMonitorOptions = {}) {
    for (const k of ['clock', 'wallClock'] as const) {
      if (options[k] !== undefined && typeof options[k] !== 'function') {
        throw new TypeError(`monitor: options.${k} must be a function`);
      }
    }
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
    this.timeZone = options.timeZone; // Absent override: Baseline adopts its persisted zone.
    this.tuner = options.tuner;
    const rateRules = options.rateRules ?? defaultRateRules();
    this.anomalyRules = options.anomalyRules ?? defaultAnomalyRules();
    this.maxRateWindow = rateRules.reduce((m, r) => Math.max(m, r.windowMs), 0);
    if (rateRules.length) {
      this.rate = new RateEvaluator(rateRules, (p, f) => this.tuner?.number(p, f) ?? f);
    }
    this.seed =
      options.baseline ??
      new Baseline({ clock: this.wallClock, installedAt: this.wallClock(), timeZone: this.timeZone });
    this.rebuildAnomaly();
    this.burst = new FileBurstDetector({
      ...(options.fileBurst ?? {}),
      threshold: (p, f) => this.tuner?.number(p, f) ?? f,
    });
    this.persistence = options.persistence;
    this.persistReady = options.persistence === undefined;
    if (options.persistence) {
      const save = options.persistence.save.bind(options.persistence);
      this.scheduler = new PersistScheduler(() => save(this.serialize()), this.clock);
      // With a combined store the tuner's AI is blocked from CONSTRUCTION
      // until restore(), and every post-restore tuner mutation dirties the
      // combined snapshot even without a body evaluate in between.
      this.tuner?.expectRestore();
      this.tuner?.setOnChange(() => this.dirty());
    }
  }

  /** The state to resume feeding back — restored snapshot or latest emitted. */
  get restoredState(): AdaptiveState | undefined {
    return this.latest;
  }

  /** Current effective baseline for the anomaly layer (seed or latest fork). */
  get baseline(): Baseline {
    for (const h of Object.values(this.latest?.[BODY_HISTORY] ?? {})) {
      if (h.anomaly?.baseline) return h.anomaly.baseline;
    }
    return this.seed;
  }

  /** Forwards one raw signal to the built-in burst detector. */
  accept(signal: Signal): BodySignal[] {
    return this.burst.accept(signal);
  }

  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    const [p, n] = this.stamp(prev, next);
    const f = new FloorEvaluator(floorTable(this.tuner)).evaluate(p, n, state);
    let acc = f.state;
    const signals: Signal[] = [];
    for (const s of f.signals) signals.push(this.tagFloor(s));
    if (this.rate) {
      const r = this.rate.evaluate(p, n, acc);
      acc = r.state;
      signals.push(...r.signals);
    }
    if (this.anomaly) {
      const a = this.anomaly.evaluate(p, n, acc);
      acc = a.state;
      signals.push(...a.signals);
    }
    this.latest = acc as AdaptiveState;
    this.dirty();
    return { signals, state: acc };
  }

  /**
   * Loads the combined snapshot (tuner + seed baseline + latch/history).
   * First install (`undefined`) leaves the seed alone; ANY malformed piece
   * disables the tuner's AI path, resets the baseline to zero learning and
   * persists a `restore-failed` marker so a restart cannot unlock.
   */
  async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    if (!this.persistence) {
      await this.tuner?.restore();
      return;
    }
    let data: string | undefined;
    try {
      data = await this.persistence.load();
    } catch {
      data = BAD;
    }
    if (data !== undefined && typeof data !== 'string') data = BAD;
    const fail = async () => {
      this.tuningDisabled = 'restore-failed';
      this.latest = undefined;
      if (this.tuner) this.tuner.restoreSnapshot(BAD); // sets its own flag too
      this.seed = new Baseline(this.baselineOptions()); // baseline reset
      this.rebuildAnomaly();
      await this.persistence?.save(JSON.stringify({ version: 1, disabled: 'restore-failed' })).catch(() => {});
      this.persistReady = true;
    };
    if (data === undefined) {
      this.tuner?.restoreSnapshot(undefined); // first install
      this.persistReady = true;
      return;
    }
    let d: Record<string, unknown> | undefined;
    try {
      const p = JSON.parse(data) as Record<string, unknown>;
      if (p && typeof p === 'object' && !Array.isArray(p)) d = p;
    } catch {
      /* corrupt */
    }
    // A v1 snapshot is REQUIRED to carry every field: baseline text, latch
    // and history records, and tuner text whenever a tuner is wired —
    // missing pieces are malformed input, never a silent first install.
    if (
      !d ||
      d.version !== 1 ||
      d.disabled === 'restore-failed' ||
      typeof d.baseline !== 'string' ||
      (this.tuner && typeof d.tuner !== 'string')
    ) {
      await fail();
      return;
    }
    if (this.tuner?.restoreSnapshot(d.tuner as string) === 'failed') {
      await fail();
      return;
    }
    const b = Baseline.deserialize(d.baseline, this.baselineOptions());
    if (b.restoreFailed) {
      await fail();
      return;
    }
    const history = parseHistory(d.history, this.baselineOptions());
    const latch = validLatch(d.latch);
    if (history === undefined || latch === undefined) {
      await fail();
      return;
    }
    this.seed = b;
    this.rebuildAnomaly();
    this.latest = { ...latch, [BODY_HISTORY]: history };
    this.persistReady = true;
    this.dirty();
  }

  /** Force-flushes the combined snapshot (no-op before restore). */
  persist(): Promise<void> {
    return this.persistReady && this.scheduler ? this.scheduler.flush() : Promise.resolve();
  }

  /** Cancels the pending write + timer, then flushes — even before restore. */
  async close(): Promise<void> {
    if (this.persistReady) await this.scheduler?.close();
    else this.scheduler?.cancel();
  }

  private dirty(): void {
    if (this.persistReady) this.scheduler?.schedule();
  }

  private baselineOptions(): BaselineOptions {
    return { clock: this.wallClock, timeZone: this.timeZone };
  }

  private rebuildAnomaly(): void {
    this.anomaly = this.anomalyRules?.length
      ? new AnomalyEvaluator(this.seed, this.anomalyRules, (p, f) => this.tuner?.number(p, f) ?? f)
      : undefined;
  }

  private serialize(): string {
    const latest = this.latest;
    const latch: BodyThresholdState = {};
    for (const k of Object.keys(latest ?? {})) latch[k] = (latest as AdaptiveState)[k];
    return JSON.stringify({
      version: 1,
      disabled: this.tuningDisabled ?? this.tuner?.tuningDisabled,
      tuner: this.tuner?.serialize(),
      baseline: this.seed.serialize(),
      latch,
      history: serializeHistory(latest?.[BODY_HISTORY]),
    });
  }

  /** Stamps monotonic times; a supplied `monotonicAt` is always respected. */
  private stamp(prev: BodyThresholdSample, next: BodyThresholdSample): [BodyThresholdSample, BodyThresholdSample] {
    const nextMono = next.monotonicAt ?? this.clock();
    if (!Number.isFinite(nextMono) || !Number.isFinite(next.at) || !Number.isFinite(this.wallClock())) {
      throw new TypeError('monitor: clocks must be finite');
    }
    const gap = Number.isFinite(next.at - prev.at) ? Math.max(0, next.at - prev.at) : 0;
    const prevMono = prev.monotonicAt ?? nextMono - Math.min(gap, this.maxRateWindow);
    return [
      { ...prev, monotonicAt: prevMono },
      { ...next, monotonicAt: nextMono },
    ];
  }

  private tagFloor(s: Signal): BodySignal {
    return { ...s, layer: 'floor', data: { ...s.data, layer: 'floor' } };
  }
}

/** Strict latch validation: known keys→severities only. */
function validLatch(v: unknown): BodyThresholdState | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: BodyThresholdState = {};
  const sev: readonly ThresholdSeverity[] = ['normal', 'warn', 'critical'];
  for (const [k, s] of Object.entries(v)) {
    if (typeof k !== 'string' || !sev.includes(s as ThresholdSeverity)) return undefined;
    out[k] = s as ThresholdSeverity;
  }
  return out;
}
