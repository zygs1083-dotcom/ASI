import { describe, expect, it } from 'vitest';
import { DiskSampler, collectDisks, type StatFsResult } from '../src/disks.js';

const statfs = (r: StatFsResult) => async () => r;

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
