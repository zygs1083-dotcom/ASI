import type { Signal, SourceRef, WatchRule } from '@asi/sense-types';
import { AttentionPipeline, type DeliveryIntent, type SessionContext } from '../src/host/attention/pipeline.ts';
import { StateStore } from '../src/host/state/store.ts';

export const SRC: SourceRef = { id: 'fs', api: 'test', host: 'local' };
export const SRC2: SourceRef = { id: 'ax', api: 'test', host: 'local' };

export function sig(partial: Partial<Signal> & Pick<Signal, 'id' | 'kind'>): Signal {
  return { at: 0, source: SRC, subject: 'sub', data: {}, ...partial };
}

export function sess(partial: Partial<SessionContext> = {}): SessionContext {
  return { id: 's1', busy: false, userInitiated: false, ...partial };
}

export function jobExit(id: string, at: number, exitCode: number, subject = 'j1', extra: Partial<Signal> = {}): Signal {
  return sig({
    id,
    kind: 'job.exited',
    at,
    subject,
    data: { exitCode, command: 'pnpm test' },
    ...extra,
  });
}

/** Feeds a failing job.exited signal, then advances past the merge window and flushes. */
export async function wake(
  pipeline: AttentionPipeline,
  clock: FakeClock,
  id: string,
  session: SessionContext = sess(),
): Promise<void> {
  await pipeline.accept(jobExit(id, clock.now, 1, id), session);
  clock.advance(2001);
  await pipeline.flush();
}

export function pipe(clock: FakeClock, rules?: WatchRule[]) {
  const store = new StateStore(clock.time);
  const intents: DeliveryIntent[] = [];
  const pipeline = new AttentionPipeline({
    store,
    deliverer: {
      deliver: (i) => {
        intents.push(i);
        return Promise.resolve();
      },
    },
    clock: clock.time,
    wallClock: clock.wallTime,
    rules,
  });
  return { store, intents, pipeline };
}

/**
 * Two independent clocks: `now` is monotonic (deadlines, budgets) and `wall`
 * is the wall clock (rule expiry, update display). `advance` moves both so
 * existing tests stay deterministic; `jumpWall` moves only the wall clock.
 */
export class FakeClock {
  now = 0;
  wall = 0;
  advance(ms: number): void {
    this.now += ms;
    this.wall += ms;
  }
  jumpWall(ms: number): void {
    this.wall += ms;
  }
  time = (): number => this.now;
  wallTime = (): number => this.wall;
}
