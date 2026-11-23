import type { SenseSnapshot, Fact as SharedFact } from '@asi/sense-types';
import type { DisksFact, DiskVolume, Fact, NeedsPanelModel } from '@asi/sense-ui';
import type { NeedsRuntime } from '../runtime.js';

export type FramesSource = ((signal: AbortSignal) => AsyncIterable<NeedsPanelModel>) & {
  invalidate?: () => void;
};

function computeStaleInMs(observedAt: number, ttlMs: number, now: number): number | undefined {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  return Math.max(0, observedAt + ttlMs - now);
}

function projectFact<T>(fact: SharedFact<T>, now: number): Fact<T> {
  if (fact.status !== 'ok') return { ...fact };
  const staleInMs = computeStaleInMs(fact.observedAt, fact.ttlMs, now);
  return staleInMs === undefined ? { ...fact } : { ...fact, staleInMs };
}

function projectDisks(disks: SenseSnapshot['state']['self']['body']['disks'], now: number): DisksFact {
  const staleInMs = disks.status === 'ok' ? computeStaleInMs(disks.observedAt, disks.ttlMs, now) : undefined;
  const value: DiskVolume[] | null =
    disks.value?.map((vol) => {
      const effStatus = vol.status ?? disks.status;
      if (effStatus !== 'ok') return { ...vol };
      const vObs = vol.observedAt ?? disks.observedAt;
      const vTtl = vol.ttlMs ?? disks.ttlMs;
      const vStale = computeStaleInMs(vObs, vTtl, now);
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
        activity: projectFact(self.activity, now),
        pending: projectFact(self.pending, now),
        tools: projectFact(self.tools, now),
        permissions: projectFact(self.permissions, now),
        body: {
          cpu: projectFact(body.cpu, now),
          memory: projectFact(body.memory, now),
          disks: projectDisks(body.disks, now),
          battery: projectFact(body.battery, now),
          thermal: projectFact(body.thermal, now),
          network: projectFact(body.network, now),
          harnessProcess: projectFact(body.harnessProcess, now),
          tokens: projectFact(body.tokens, now),
        },
      },
      env: {
        where: {
          model: projectFact(env.where.model, now),
          harness: projectFact(env.where.harness, now),
          observed: projectFact(env.where.observed, now),
          toolExec: projectFact(env.where.toolExec, now),
        },
        frontApp: projectFact(env.frontApp, now),
        focusedWindow: projectFact(env.focusedWindow, now),
        activeJobs: {
          ...projectFact(env.activeJobs, now),
          value:
            env.activeJobs.value?.map((job) => ({
              id: job.id,
              name: job.command ?? job.id,
              status: job.status,
              ...(job.owner ? { owner: job.owner } : {}),
            })) ?? null,
        },
        ...(env.system ? { system: projectFact(env.system, now) } : {}),
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
  };
}

export function createFramesSource(runtime: NeedsRuntime): FramesSource {
  const subscribers = new Set<() => void>();
  const source = async function* (signal: AbortSignal): AsyncIterable<NeedsPanelModel> {
    let changed = true;
    let wake: (() => void) | undefined;
    const notify = () => {
      changed = true;
      wake?.();
    };
    const off = runtime.subscribe(notify);
    subscribers.add(notify);
    signal.addEventListener('abort', notify);
    try {
      while (!signal.aborted) {
        if (!changed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        changed = false;
        yield buildPanelModel(runtime);
      }
    } finally {
      signal.removeEventListener('abort', notify);
      subscribers.delete(notify);
      off();
    }
  };
  return Object.assign(source, {
    invalidate: () => {
      for (const notify of subscribers) notify();
    },
  });
}
