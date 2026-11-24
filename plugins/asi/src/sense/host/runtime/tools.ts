import type { DshSource } from '../sources/dsh.ts';
import type { HelperSource } from '../sources/helper.ts';
import type { SenseBus } from './bus.ts';
import type { DshPort, SenseActions } from './ports.ts';
import type { Settings } from './settings.ts';

export function pauseAction(
  settings: Settings,
  current: () => boolean,
  apply: (value: boolean) => Promise<void>,
  check: () => void,
): SenseActions['pause'] {
  let tail = Promise.resolve();
  let broken = false;
  return (value) => {
    const run = tail.then(async () => {
      check();
      if (broken) throw new Error('pause state unavailable');
      const previous = current();
      try {
        if (value !== previous) await apply(value);
        check();
        await settings.update((draft) => {
          draft.paused = value;
        });
        check();
      } catch (error) {
        if (current() !== previous) {
          try {
            check();
            await apply(previous);
          } catch (rollback) {
            broken = true;
            throw new AggregateError([error, rollback], 'pause failed and rollback failed');
          }
        }
        throw error;
      }
    });
    tail = run.catch(() => {});
    return run;
  };
}

export function runtimeTools(
  bus: SenseBus,
  helper: HelperSource,
  titlesAllowed: () => boolean,
  dsh: DshPort,
  dshSource: DshSource,
) {
  return {
    refreshDetail: () => helper.refreshDetail(),
    envState: (section?: 'self' | 'env' | 'observation', sessionId?: string) => {
      const targetSession =
        sessionId !== undefined && !bus.isInternalSession(sessionId) ? sessionId : bus.currentSessionId();
      const state = dshSource.stateFor(targetSession, bus.state());
      if (!titlesAllowed()) state.env.focusedWindow.value = null;
      if (sessionId !== undefined && !bus.isInternalSession(sessionId)) {
        try {
          if (!dshSource.hasSession(sessionId)) throw new Error('session unavailable');
          if (!dsh.modelJobs) throw new Error('job source unavailable');
          state.env.activeJobs.value = dsh.modelJobs(sessionId);
        } catch {
          state.env.activeJobs.value = null;
          state.env.activeJobs.status = 'unavailable';
        }
      }
      return section ? state[section] : state;
    },
  };
}
