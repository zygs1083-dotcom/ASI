import type { GrowthRuntime } from '../../growth/host/runtime.ts';
import type { IntuitionRuntime } from '../../intuition/host/runtime.ts';
import { buildPanelModel } from '../../needs/host/dsh/frames.ts';
import type { NeedsRuntime } from '../../needs/host/runtime.ts';
import type { SleepRuntime } from '../../sleep/host/runtime.ts';
import { buildTactGuidance, SILENT_ADAPTATION_RULE } from '../../tom/host/evaluator.ts';
import type { TomRuntime } from '../../tom/host/runtime.ts';
import type { TomPanelModel } from '../../tom/shared/types.ts';
import type { AsiPanelModel } from './wire-types.ts';

export type AsiFramesSource = ((signal: AbortSignal) => AsyncIterable<AsiPanelModel>) & {
  invalidate?: (sinceRevision?: number) => void;
  revision?: () => number;
};

export const DEFAULT_ASI_FRAME_THROTTLE_MS = 180;

export interface AsiFramesRuntimes {
  needs: NeedsRuntime;
  sleep: Pick<SleepRuntime, 'panelModel' | 'subscribe'>;
  growth: Pick<GrowthRuntime, 'panelModel' | 'subscribe'>;
  intuition: Pick<IntuitionRuntime, 'panelModel' | 'subscribe'>;
  tom?: Pick<TomRuntime, 'panelModel' | 'subscribe'>;
}

function buildFallbackTomPanelModel(now: number): TomPanelModel {
  const dimensions = { focus: 65, friction: 0, pace: 50, presence: 75 };
  return {
    now,
    enabled: true,
    sensePaused: false,
    state: 'steady_flow',
    source: 'inferred',
    confidence: 0.6,
    dimensions,
    guidance: {
      ...buildTactGuidance('steady_flow', dimensions),
      silentAdaptationRule: SILENT_ADAPTATION_RULE,
    },
    reasons: ['交互节奏与环境信号平稳。'],
    manualOverride: null,
    baseline: {
      sampleCount: 0,
      avgCadenceSec: 65,
      avgPromptChars: 140,
      avgSwitchesPer5m: 4,
      calibrationCount: 0,
    },
    driveSatisfaction: 95,
    driveZone: 'comfortable',
    suppressed: false,
  };
}

export function buildAsiPanelModel(runtimes: AsiFramesRuntimes): AsiPanelModel {
  const needs = buildPanelModel(runtimes.needs);
  return {
    needs,
    sleep: runtimes.sleep.panelModel(),
    growth: runtimes.growth.panelModel(),
    intuition: runtimes.intuition.panelModel(),
    tom: runtimes.tom ? runtimes.tom.panelModel() : buildFallbackTomPanelModel(needs.now),
  };
}

export function createAsiFramesSource(
  runtimes: AsiFramesRuntimes,
  options?: { throttleMs?: number; now?: () => number },
): AsiFramesSource {
  const throttleMs = Math.max(0, options?.throttleMs ?? DEFAULT_ASI_FRAME_THROTTLE_MS);
  const now = options?.now ?? (() => performance.now());
  const subscribers = new Set<(sinceRevision?: number) => void>();
  let currentRevision = 0;

  const source = async function* (signal: AbortSignal): AsyncIterable<AsiPanelModel> {
    if (signal.aborted) return;

    let changed = true;
    let immediate = true;
    let timerFired = false;
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    let emittedRevision = -1;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanedUp = false;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const triggerWake = () => {
      const fn = wake;
      wake = undefined;
      fn?.();
    };

    const scheduleWake = () => {
      if (immediate || throttleMs <= 0) {
        clearTimer();
        triggerWake();
        return;
      }
      const remainingMs = lastEmitAt + throttleMs - now();
      if (remainingMs <= 0) {
        clearTimer();
        triggerWake();
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          timerFired = true;
          triggerWake();
        }, Math.ceil(remainingMs));
      }
    };

    const onRuntimeChange = () => {
      currentRevision += 1;
      changed = true;
      if (wake !== undefined) {
        scheduleWake();
      }
    };

    const onInvalidate = (sinceRevision?: number) => {
      if (sinceRevision !== undefined && !changed && emittedRevision > sinceRevision) {
        return;
      }
      currentRevision += 1;
      changed = true;
      immediate = true;
      clearTimer();
      triggerWake();
    };

    let offNeeds: (() => void) | undefined = runtimes.needs.subscribe(onRuntimeChange);
    let offSleep: (() => void) | undefined = runtimes.sleep.subscribe(onRuntimeChange);
    let offGrowth: (() => void) | undefined = runtimes.growth.subscribe(onRuntimeChange);
    let offIntuition: (() => void) | undefined = runtimes.intuition.subscribe(onRuntimeChange);
    let offTom: (() => void) | undefined = runtimes.tom?.subscribe(onRuntimeChange);

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimer();
      signal.removeEventListener('abort', onAbort);
      subscribers.delete(onInvalidate);
      const uNeeds = offNeeds;
      const uSleep = offSleep;
      const uGrowth = offGrowth;
      const uIntuition = offIntuition;
      const uTom = offTom;
      offNeeds = undefined;
      offSleep = undefined;
      offGrowth = undefined;
      offIntuition = undefined;
      offTom = undefined;
      uNeeds?.();
      uSleep?.();
      uGrowth?.();
      uIntuition?.();
      uTom?.();
    };

    function onAbort(): void {
      cleanup();
      triggerWake();
    }

    subscribers.add(onInvalidate);
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) {
      cleanup();
      return;
    }

    try {
      while (!signal.aborted) {
        if (!changed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }

        if (!immediate && !timerFired && throttleMs > 0) {
          const remainingMs = lastEmitAt + throttleMs - now();
          if (remainingMs > 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              clearTimer();
              timer = setTimeout(() => {
                timer = undefined;
                timerFired = true;
                triggerWake();
              }, Math.ceil(remainingMs));
            });
            clearTimer();
            wake = undefined;
            continue;
          }
        }

        changed = false;
        immediate = false;
        timerFired = false;
        emittedRevision = currentRevision;
        lastEmitAt = now();
        yield buildAsiPanelModel(runtimes);
      }
    } finally {
      cleanup();
    }
  };

  return Object.assign(source, {
    revision: () => currentRevision,
    invalidate: (sinceRevision?: number) => {
      for (const sub of [...subscribers]) {
        sub(sinceRevision);
      }
    },
  });
}
