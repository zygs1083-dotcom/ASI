import type { BodyEvaluation, BodyEvaluator, BodyThresholdSample, BodyThresholdState, Signal } from '@asi/sense-types';
import { BODY_THRESHOLDS, type BodyThresholds, FloorEvaluator } from '../attention/thresholds.ts';
import type { AnomalyEvaluator } from './anomaly.ts';
import type { BodySignal } from './metrics.ts';
import { RateEvaluator, type RateRule } from './rate.ts';
import type { Tuner } from './tuner.ts';

export interface BodyMonitorOptions {
  rateRules?: readonly RateRule[];
  /** Supplied pre-built; its threshold reader is the caller's choice. */
  anomaly?: AnomalyEvaluator;
  tuner?: Tuner;
}

/**
 * Composes the three §2.2c layers behind one {@link BodyEvaluator}: the M1
 * floor (always evaluated; a tuner may only ever *tighten* it), a
 * {@link RateEvaluator} whose limits resolve live through `tuner.number`,
 * and an optional {@link AnomalyEvaluator} (its threshold reader is chosen
 * where it is constructed — wire `tuner.number` there too if desired).
 * Caller latch state threads through every layer in order floor → rate →
 * anomaly; emitted signals carry their layer tag (`floor` is stamped onto
 * the M1 `body.threshold` signals here, rate/baseline tag themselves).
 */
export class BodyMonitor implements BodyEvaluator {
  private readonly rate?: RateEvaluator;
  private readonly anomaly?: AnomalyEvaluator;
  private readonly tuner?: Tuner;

  constructor(options: BodyMonitorOptions = {}) {
    this.tuner = options.tuner;
    if (options.rateRules?.length) {
      this.rate = new RateEvaluator(options.rateRules, (p, f) => this.tuner?.number(p, f) ?? f);
    }
    this.anomaly = options.anomaly;
  }

  evaluate(prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState): BodyEvaluation {
    const signals: Signal[] = [];
    const f = new FloorEvaluator(this.floorTable()).evaluate(prev, next, state);
    let acc = f.state;
    for (const s of f.signals) signals.push(this.tagFloor(s));
    if (this.rate) {
      const r = this.rate.evaluate(prev, next, acc);
      acc = r.state;
      signals.push(...r.signals);
    }
    if (this.anomaly) {
      const a = this.anomaly.evaluate(prev, next, acc);
      acc = a.state;
      signals.push(...a.signals);
    }
    return { signals, state: acc };
  }

  /** Tuner values can only raise floor thresholds — never loosen them. */
  private floorTable(): BodyThresholds {
    const t = this.tuner;
    if (!t) return BODY_THRESHOLDS;
    const tighten = (base: number, name: string) => Math.max(base, Math.min(1, t.number(name, base)));
    const section = (k: 'disk' | 'context' | 'battery') => ({
      warn: tighten(BODY_THRESHOLDS[k].warn, `floor.${k}.warn`),
      critical: tighten(BODY_THRESHOLDS[k].critical, `floor.${k}.critical`),
    });
    return {
      disk: section('disk'),
      context: section('context'),
      battery: section('battery'),
      hysteresis: BODY_THRESHOLDS.hysteresis,
    };
  }

  private tagFloor(s: Signal): BodySignal {
    return { ...s, layer: 'floor', data: { ...s.data, layer: 'floor' } };
  }
}
