import type { SensePanelModel } from '@asi/sense-ui';
import type { createSenseRuntime } from '../runtime/index.ts';

type Runtime = Pick<ReturnType<typeof createSenseRuntime>, 'state' | 'subscribe' | 'rules'>;
export type FramesSource = ((signal: AbortSignal) => AsyncIterable<SensePanelModel>) & { invalidate?: () => void };

export function createFramesSource(runtime: Runtime): FramesSource {
  const subscribers = new Set<() => void>();
  const source = async function* (signal: AbortSignal) {
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
        const state = runtime.state();
        const jobs = state.env.activeJobs;
        const settings = runtime.rules.settings();
        yield {
          state: {
            ...state,
            env: {
              ...state.env,
              activeJobs: {
                ...jobs,
                value:
                  jobs.value?.map((job) => ({ id: job.id, name: job.command ?? job.id, status: job.status })) ?? null,
              },
            },
          },
          events: [],
          rules: runtime.rules.list().map((rule) => ({
            ...rule,
            name: rule.id,
            enabled: runtime.rules.isEnabled(rule.id),
            confirmed: rule.approved,
          })),
          ...settings,
          now: Date.now(),
          history: {
            cpu: [],
            memory: [],
            battery: [],
            thermal: [],
            networkRx: [],
            networkTx: [],
            processCpu: [],
            processRss: [],
            tokens: [],
            disks: {},
          },
        };
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
