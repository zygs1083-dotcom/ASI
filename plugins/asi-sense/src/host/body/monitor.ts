import type { BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState, Signal } from '@asi/sense-types';
import { FloorEvaluator } from '../attention/thresholds.ts';
import { AnomalyEvaluator, type AnomalyRule } from './anomaly.ts';
import { Baseline, type BaselineOptions } from './baseline.ts';
import { FileBurstDetector, type FileBurstOptions } from './burst.ts';
import type { BodySignal } from './metrics.ts';
import { type BodyPersistence, PersistScheduler } from './persistence.ts';
import { RateEvaluator, type RateRule } from './rate.ts';
import { defaultAnomalyRules, defaultRateRules, floorTable } from './rules.ts';
import { type AdaptiveState, BODY_HISTORY, parseHistory, serializeHistory, validLatch } from './state.ts';
import type { Tuner } from './tuner.ts';

export interface BodyMonitorOptions {
  /** Injected MONOTONIC clock for installation and persistence bookkeeping. */
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
 * Samples must carry monotonic receipt times supplied by the host.
 * Wall time is used only for local buckets and signal display.
 * Adaptive state lives in caller-threaded
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
  private seed: Baseline;
  private anomaly?: AnomalyEvaluator;
  private latest?: AdaptiveState;
  private restored = false;
  /** Saves stay blocked until {@link restore} settles — never overwrite the stored snapshot first. */
  private persistReady: boolean;
  /** Monitor-level kill switch, independent of a wired tuner. */
  tuningDisabled: 'restore-failed' | 'storage-failed' | undefined;

  constructor(options: BodyMonitorOptions = {}) {
    for (const k of ['clock', 'wallClock'] as const) {
      if (options[k] !== undefined && typeof options[k] !== 'function') {
        throw new TypeError(`monitor: options.${k} must be a function`);
      }
    }
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
    this.timeZone = options.timeZone; // Absent override: Baseline uses the runtime zone.
    this.tuner = options.tuner;
    const rateRules = options.rateRules ?? defaultRateRules();
    this.anomalyRules = options.anomalyRules ?? defaultAnomalyRules();
    if (rateRules.length) {
      this.rate = new RateEvaluator(rateRules, (p, f) => this.tuner?.number(p, f) ?? f);
    }
    this.seed =
      options.baseline ??
      new Baseline({
        clock: this.wallClock,
        installedAt: this.wallClock(),
        timeZone: this.timeZone,
        monotonicAt: this.clock(),
      });
    this.rebuildAnomaly();
    this.burst = new FileBurstDetector({
      ...(options.fileBurst ?? {}),
      threshold: (p, f) => this.tuner?.number(p, f) ?? f,
    });
    this.persistence = options.persistence;
    this.persistReady = options.persistence === undefined;
    if (options.persistence) {
      const save = options.persistence.save.bind(options.persistence);
      this.scheduler = new PersistScheduler(
        () => save(this.serialize()),
        this.clock,
        10_000,
        () => {
          this.tuningDisabled = 'storage-failed';
          this.tuner?.disableStorage();
        },
      );
      // With a combined store the tuner's AI is blocked from CONSTRUCTION
      // until restore(), and every post-restore tuner mutation commits the
      // combined snapshot even without a body evaluate in between.
      this.tuner?.expectRestore();
      this.tuner?.setCommit((snapshot, publish) => {
        if (!this.persistReady || !this.scheduler) return Promise.reject(new Error('monitor: restore pending'));
        return this.scheduler
          .commit(() => save(this.serialize(snapshot())), publish)
          .catch((error) => {
            this.tuningDisabled = 'storage-failed';
            throw error;
          });
      });
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
  accept(signal: Signal, receivedAt: number): BodySignal[] {
    return this.burst.accept(signal, receivedAt);
  }

  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    const [p, n] = this.validateSamples(prev, next);
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
      d?.version !== 1 ||
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
  async persist(): Promise<void> {
    if (!this.persistReady) return;
    await this.tuner?.persist();
    await this.scheduler?.flush();
  }

  /** Cancels the pending timer and flushes only after restore. */
  async close(): Promise<void> {
    if (this.persistReady) {
      await this.tuner?.close();
      await this.scheduler?.close();
    } else this.scheduler?.cancel();
  }

  private dirty(): void {
    if (this.persistReady) this.scheduler?.schedule();
  }

  private baselineOptions(): BaselineOptions {
    return { clock: this.wallClock, timeZone: this.timeZone, monotonicAt: this.clock() };
  }

  private rebuildAnomaly(): void {
    this.anomaly = this.anomalyRules?.length
      ? new AnomalyEvaluator(this.seed, this.anomalyRules, (p, f) => this.tuner?.number(p, f) ?? f)
      : undefined;
  }

  private serialize(tunerSnapshot?: string): string {
    const latest = this.latest;
    const seed = this.seed.clone();
    seed.advance(this.clock());
    const latch: BodyThresholdState = {};
    for (const k of Object.keys(latest ?? {})) latch[k] = (latest as AdaptiveState)[k];
    return JSON.stringify({
      version: 1,
      disabled: this.tuningDisabled ?? this.tuner?.tuningDisabled,
      tuner: tunerSnapshot ?? this.tuner?.serialize(),
      baseline: seed.serialize(),
      latch,
      history: serializeHistory(latest?.[BODY_HISTORY]),
    });
  }

  /** Requires finite monotonic receipt times on both samples. */
  private validateSamples(
    prev: BodyThresholdSample,
    next: BodyThresholdSample,
  ): [BodyThresholdSample, BodyThresholdSample] {
    if (!Number.isFinite(prev.monotonicAt) || !Number.isFinite(next.monotonicAt) || !Number.isFinite(next.at)) {
      throw new TypeError('monitor: clocks must be finite');
    }
    return [prev, next];
  }

  private tagFloor(s: Signal): BodySignal {
    return { ...s, layer: 'floor', data: { ...s.data, layer: 'floor' } };
  }
}
