import type { SenseActions } from './ports.ts';

export function guardActions(actions: SenseActions, epoch: () => number, check: (epoch: number) => void) {
  const pending = new Set<Promise<unknown>>();
  const guarded = Object.fromEntries(
    Object.entries(actions).map(([key, fn]) => [
      key,
      (...args: never[]) => {
        try {
          const generation = epoch();
          check(generation);
          const result = fn(...args).then((value: unknown) => {
            check(generation);
            return value;
          });
          pending.add(result);
          void result.then(
            () => pending.delete(result),
            () => pending.delete(result),
          );
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      },
    ]),
  ) as unknown as SenseActions;
  return { actions: guarded, wait: () => Promise.allSettled([...pending]) };
}

export async function boundedShutdown(work: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('runtime shutdown timed out')), 950);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
