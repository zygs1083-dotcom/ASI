import type { SenseSnapshot, Fact as SharedFact } from '@asi/sense-types';
import type { DisksFact, DiskVolume, Fact, NeedsPanelModel } from '@asi/sense-ui';
import type { NeedsRuntime } from '../runtime.js';

export type FramesSource = ((signal: AbortSignal) => AsyncIterable<NeedsPanelModel>) & {
  invalidate?: (sinceRevision?: number) => void;
  revision?: () => number;
};

function computeStaleInMs(observedAt: number, ttlMs: number, now: number): number | undefined {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  return Math.max(0, observedAt + ttlMs - now);
}

function projectFact<T>(fact: SharedFact<T>, path: string, now: number, runtime: NeedsRuntime): Fact<T> {
  if (fact.status !== 'ok') return { ...fact };
  const staleInMs = runtime.factStaleInMs(path) ?? computeStaleInMs(fact.observedAt, fact.ttlMs, now);
  return staleInMs === undefined ? { ...fact } : { ...fact, staleInMs };
}

function projectDisks(
  disks: SenseSnapshot['state']['self']['body']['disks'],
  now: number,
  runtime: NeedsRuntime,
): DisksFact {
  const staleInMs =
    disks.status === 'ok'
      ? (runtime.factStaleInMs('self.body.disks') ?? computeStaleInMs(disks.observedAt, disks.ttlMs, now))
      : undefined;
  const value: DiskVolume[] | null =
    disks.value?.map((vol) => {
      const effStatus = vol.status ?? disks.status;
      if (effStatus !== 'ok') return { ...vol };
      const vObs = vol.observedAt ?? disks.observedAt;
      const vTtl = vol.ttlMs ?? disks.ttlMs;
      const vStale =
        runtime.factStaleInMs(`self.body.disks.mount#${vol.mount}`) ??
        (vObs === disks.observedAt && vTtl === disks.ttlMs && staleInMs !== undefined
          ? staleInMs
          : computeStaleInMs(vObs, vTtl, now));
      return vStale === undefined ? { ...vol } : { ...vol, staleInMs: vStale };
    }) ?? null;
  return {
    ...disks,
    value,
    ...(staleInMs === undefined ? {} : { staleInMs }),
  };
}

export function buildPanelModel(runtime: NeedsRuntime): NeedsPanelModel {
  const sense = runtime.senseSnapshot();
  const needs = runtime.snapshot();
  const { now } = sense;
  const { self, env, observation } = sense.state;
  const { body } = self;

  return {
    now: needs.now,
    paused: needs.paused,
    sendTitles: needs.sendTitles,
    state: {
      self: {
        activity: projectFact(self.activity, 'self.activity', now, runtime),
        pending: projectFact(self.pending, 'self.pending', now, runtime),
        tools: projectFact(self.tools, 'self.tools', now, runtime),
        permissions: projectFact(self.permissions, 'self.permissions', now, runtime),
        body: {
          cpu: projectFact(body.cpu, 'self.body.cpu', now, runtime),
          memory: projectFact(body.memory, 'self.body.memory', now, runtime),
          disks: projectDisks(body.disks, now, runtime),
          battery: projectFact(body.battery, 'self.body.battery', now, runtime),
          thermal: projectFact(body.thermal, 'self.body.thermal', now, runtime),
          network: projectFact(body.network, 'self.body.network', now, runtime),
          harnessProcess: projectFact(body.harnessProcess, 'self.body.harnessProcess', now, runtime),
          tokens: projectFact(body.tokens, 'self.body.tokens', now, runtime),
        },
      },
      env: {
        where: {
          model: projectFact(env.where.model, 'env.where.model', now, runtime),
          harness: projectFact(env.where.harness, 'env.where.harness', now, runtime),
          observed: projectFact(env.where.observed, 'env.where.observed', now, runtime),
          toolExec: projectFact(env.where.toolExec, 'env.where.toolExec', now, runtime),
        },
        frontApp: projectFact(env.frontApp, 'env.frontApp', now, runtime),
        focusedWindow: projectFact(env.focusedWindow, 'env.focusedWindow', now, runtime),
        activeJobs: {
          ...projectFact(env.activeJobs, 'env.activeJobs', now, runtime),
          value:
            env.activeJobs.value?.map((job) => ({
              id: job.id,
              name: job.command ?? job.id,
              status: job.status,
              ...(job.owner ? { owner: job.owner } : {}),
            })) ?? null,
        },
        ...(env.system ? { system: projectFact(env.system, 'env.system', now, runtime) } : {}),
      },
      observation: structuredClone(observation),
    },
    history: structuredClone(sense.history),
    sampleIntervalsMs: { ...sense.sampleIntervalsMs },
    needs: needs.needs,
    overallZone: needs.overallZone,
    instinct: needs.instinct,
    maintenanceSession: needs.maintenanceSession,
    helpCards: needs.helpCards,
    recentMaintenance: needs.records,
    ...(needs.actionLedger ? { actionLedger: needs.actionLedger } : {}),
    ...(needs.higherOrderDrives ? { higherOrderDrives: needs.higherOrderDrives } : {}),
    ...(needs.higherOrderSuppressed !== undefined ? { higherOrderSuppressed: needs.higherOrderSuppressed } : {}),
    ...(needs.higherOrderSuppressionReason ? { higherOrderSuppressionReason: needs.higherOrderSuppressionReason } : {}),
  };
}

export const DEFAULT_FRAME_THROTTLE_MS = 200;

export interface FramesSourceOptions {
  throttleMs?: number;
  now?: () => number;
}

export function createFramesSource(runtime: NeedsRuntime, options?: FramesSourceOptions): FramesSource {
  const throttleMs = Math.max(0, options?.throttleMs ?? DEFAULT_FRAME_THROTTLE_MS);
  const now = options?.now ?? (() => performance.now());
  const subscribers = new Set<(sinceRevision?: number) => void>();
  let currentRevision = 0;

  const source = async function* (signal: AbortSignal): AsyncIterable<NeedsPanelModel> {
    if (signal.aborted) {
      return;
    }

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

    let off: (() => void) | undefined = runtime.subscribe(onRuntimeChange);

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimer();
      signal.removeEventListener('abort', onAbort);
      subscribers.delete(onInvalidate);
      const unsub = off;
      off = undefined;
      unsub?.();
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
        yield buildPanelModel(runtime);
      }
    } finally {
      cleanup();
    }
  };

  return Object.assign(source, {
    revision: () => currentRevision,
    invalidate: (sinceRevision?: number) => {
      for (const invalidateSubscriber of [...subscribers]) {
        invalidateSubscriber(sinceRevision);
      }
    },
  });
}
