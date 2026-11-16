import type { BodyEvaluation, BodyThresholdSample, BodyThresholdState } from '@asi/sense-types';
import { validateSamples } from './monitor-snapshot.ts';
import type { AutomaticBodyEvaluation, RebaselineManager, RebaselineSuggestion } from './rebaseline.ts';
import type { AdaptiveState } from './state.ts';

export type RateSample = { stream: string; mono: number; wall: number; contextSession?: string };
type View = { state?: AdaptiveState; sample?: RateSample; suggestions: RebaselineSuggestion[] };
type Commit = (result: AutomaticBodyEvaluation, publish: () => void) => void;

export class MonitorView {
  current?: View;

  run(
    rebaser: RebaselineManager,
    next: BodyThresholdSample,
    state: BodyThresholdState,
    evaluate: () => BodyEvaluation,
    capture: () => View,
    commit?: Commit,
  ): Promise<AutomaticBodyEvaluation> {
    let view: View | undefined;
    const publish = () => {
      if (this.current === view) this.current = undefined;
    };
    return rebaser
      .run(
        next,
        state,
        () => {
          if (commit) this.current = view = capture();
          return evaluate();
        },
        (result) => commit?.(result, publish),
      )
      .finally(publish);
  }
}

export function autoEvaluator(
  view: MonitorView,
  rebaser: () => RebaselineManager | undefined,
  evaluate: (prev: BodyThresholdSample, next: BodyThresholdSample, state: BodyThresholdState) => BodyEvaluation,
  capture: () => View,
) {
  return (
    prev: BodyThresholdSample,
    next: BodyThresholdSample,
    state: BodyThresholdState,
    commit?: Commit,
    clock?: { mono(): number; wall(): number },
  ) => {
    const current = rebaser();
    if (!current) return Promise.reject(new Error('monitor: rebaseline suggestions require persistent tuner'));
    validateSamples(prev, next);
    return view.run(
      current,
      next,
      state,
      () => {
        const sample = clock ? { ...next, evaluatedAt: { mono: clock.mono(), wall: clock.wall() } } : next;
        return evaluate(prev, sample, state);
      },
      capture,
      commit,
    );
  };
}
