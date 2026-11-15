import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskSampler, collectDisks, type StatFsResult } from '../src/disks.js';

const statfs = (r: StatFsResult) => async () => r;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('collectDisks', () => {
  it('dedups volumes by stat.dev and reports queried paths as mount', async () => {
    const devs: Record<string, number> = { '/': 1, '/work': 1 };
    const out = await collectDisks('/work', {
      stat: async (p) => ({ dev: devs[p]! }),
      statfs: statfs({ bsize: 4096, blocks: 1000, bavail: 250 }),
      resolve: (p) => p,
    });
    expect(out).toEqual([{ mount: '/', total: 4096 * 1000, free: 4096 * 250 }]);
  });

  it('reports both volumes when dev differs, free from bavail', async () => {
    const devs: Record<string, number> = { '/': 1, '/work': 2 };
    const out = await collectDisks('/work', {
      stat: async (p) => ({ dev: devs[p]! }),
      statfs: async () => ({ bsize: 512, blocks: 2000, bavail: 400 }),
      resolve: (p) => p,
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ mount: '/work', total: 512 * 2000, free: 512 * 400 });
  });

  it('propagates inspection failures', async () => {
    await expect(collectDisks('/work', {
      stat: async () => ({ dev: 1 }),
      statfs: async () => { throw new Error('statfs failed'); },
      resolve: (p) => p,
    })).rejects.toThrow('statfs failed');
  });
});

describe('DiskSampler in-flight bound', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('republishes the last successful scan as stale while a scan is in flight', async () => {
    let wedge = false;
    const s = new DiskSampler({
      stat: async (p) => (wedge ? new Promise<{ dev: number }>(() => {}) : { dev: p === '/' ? 1 : 2 }),
      statfs: async () => ({ bsize: 4096, blocks: 10, bavail: 5 }),
      resolve: (p) => p,
    });
    const first = await s.sample('/work', 6000);
    expect(first.status).toBe('ok');
    wedge = true;
    void s.sample('/work', 6000); // wedged second scan
    const busy = await s.sample('/work', 6000);
    expect(busy.status).toBe('stale');
    expect(busy.value).toEqual(first.value); // whole-aggregate stale
    expect(busy.observedAt).toBe(first.observedAt);
  });

  it('an aborted late-resolving scan updates nothing and releases after settle', async () => {
    const d = deferred<{ dev: number }>();
    let statCalls = 0;
    let statfsCalls = 0;
    let wedgeNext = false;
    const s = new DiskSampler({
      stat: async (p) => {
        statCalls += 1;
        if (statCalls === 1) return d.promise;
        if (wedgeNext) return new Promise<{ dev: number }>(() => {});
        return { dev: p === '/' ? 1 : 2 };
      },
      statfs: async () => { statfsCalls += 1; return { bsize: 4096, blocks: 10, bavail: 5 }; },
      resolve: (p) => p,
    });
    const controller = new AbortController();
    const pending = s.sample('/work', 6000, controller.signal);
    controller.abort();
    d.resolve({ dev: 1 }); // late stat: must not reach statfs or the next path
    expect((await pending).status).not.toBe('ok');
    expect(statfsCalls).toBe(0);

    wedgeNext = true;          // the next scan wedges; busy republish proves
    void s.sample('/work', 6000); // the aborted scan never became "last success"
    const busy = await s.sample('/work', 6000);
    expect(busy.status).toBe('stale');
    expect(busy.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DiskSampler', () => {
  it('wraps success into an ok fact', async () => {
    const s = new DiskSampler({
      stat: async (p) => ({ dev: p === '/' ? 1 : 2 }),
      statfs: async () => ({ bsize: 4096, blocks: 10, bavail: 5 }),
      resolve: (p) => `/abs/${p}`,
    });
    const f = await s.sample('cwd', 6000);
    expect(f.status).toBe('ok');
    expect(f.value?.[1]?.mount).toBe('/abs/cwd');
  });

  it('returns unavailable instead of a partial ok when a volume fails', async () => {
    const s = new DiskSampler({
      stat: async (p) => ({ dev: p === '/' ? 1 : 2 }),
      statfs: async (p) => {
        if (p === '/abs/cwd') throw new Error('gone');
        return { bsize: 4096, blocks: 10, bavail: 5 };
      },
      resolve: (p) => `/abs/${p}`,
    });
    const f = await s.sample('cwd', 6000);
    expect(f.status).toBe('unavailable');
    expect(f.value).toBeNull();
  });
});
