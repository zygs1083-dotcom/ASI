export const REQUIRED_OK = ['cpu', 'memory', 'disks', 'network'] as const;

export function smokeProgressOk(samples: number, ok: ReadonlySet<string>, expected: number): boolean {
  return samples >= Math.ceil(expected * 0.9) && REQUIRED_OK.every((key) => ok.has(key));
}

export function cpuWithinBudget(user: number, sys: number, real: number): boolean {
  return [user, sys, real].every((n) => Number.isFinite(n) && n >= 0)
    && real > 0 && 100 * (user + sys) / real <= 0.6;
}
