import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskSampler, collectDisks, type DisksDeps, type StatFsResult } from '../src/disks.js';
import type { Body, Fact, SourceRef } from '@asi/sense-types';
import { bodyThresholdSignals } from '../../../plugins/asi-sense/src/host/attention/thresholds.js';

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

describe('DiskSampler', () => {
  let t = 0;
  beforeEach(() => { t = 0; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };

  const make = (over: Partial<DisksDeps> = {}) => {
    const stats: string[] = [];
    const statfss: string[] = [];
    const stat = over.stat ?? (async (p: string) => ({ dev: p === '/' ? 1 : 2 }));
    const statfs = over.statfs ?? (async () => ({ bsize: 4096, blocks: 10, bavail: 5 }));
    const s = new DiskSampler({
      resolve: (p) => p,
      now: () => t,
      wall: () => t,
      ...over,
      // wrap after spreading so call recording always covers user overrides
      stat: async (p) => { stats.push(p); return stat(p); },
      statfs: async (p) => { statfss.push(p); return statfs(p); },
    });
    return { s, stats, statfss };
  };

  it('resolves a Promise of the current snapshot: unknown first, then each volume', async () => {
    const { s } = make();
    const pending = s.sample('/w', 6000);
    expect(pending).toBeInstanceOf(Promise); // snapshot is sync; I/O is not awaited
    const first = await pending;
    expect(first.status).toBe('unknown');
    expect(first.value).toBeNull();
    expect(first.unavailableMounts).toEqual(['/', '/w']);
    await flush();
    const f = await s.sample('/w', 6000);
    expect(f.status).toBe('ok');
    expect(f.value).toEqual([
      { mount: '/', total: 40960, free: 20480, status: 'ok', observedAt: 0, ttlMs: 6000 },
      { mount: '/w', total: 40960, free: 20480, status: 'ok', observedAt: 0, ttlMs: 6000 },
    ]);
    expect(f.unavailableMounts).toBeUndefined();
  });

  it('keeps a wedged cwd volume out of the value while root data lands', async () => {
    const wedge = deferred<{ dev: number }>();
    const { s, statfss } = make({ stat: async (p) => (p === '/w' ? wedge.promise : { dev: 1 }) });
    await s.sample('/w', 6000);
    await flush();
    const f = await s.sample('/w', 6000);
    expect(f.status).toBe('ok');
    expect(f.value?.map((v) => v.mount)).toEqual(['/']);
    expect(f.unavailableMounts).toEqual(['/w']);
    wedge.resolve({ dev: 1 });
    await flush();
    const f2 = await s.sample('/w', 6000);
    expect(statfss).toEqual(['/', '/w']); // the late stat still completes normally
    expect(f2.value?.map((v) => v.mount)).toEqual(['/']); // same dev deduped
    expect(f2.unavailableMounts).toBeUndefined();
  });

  it('times out a wedged stat after 3s, discards the late result, and retries next period', async () => {
    const wedge = deferred<{ dev: number }>();
    let calls = 0;
    const { s, statfss } = make({
      stat: async (p) => {
        if (p !== '/w') return { dev: 1 };
        calls += 1;
        return calls === 1 ? wedge.promise : { dev: 2 };
      },
    });
    await s.sample('/w', 6000);
    await flush();
    t = 3000;
    await vi.advanceTimersByTimeAsync(3100); // fire the volume's 3s timeout
    wedge.resolve({ dev: 2 }); // late stat: aborted generation must discard it
    await flush();
    expect(statfss).toEqual(['/']); // it never reached a '/w' statfs
    t = 5000; // attemptedAt 3000 + period 2000 -> due again
    await s.sample('/w', 6000);
    await flush();
    const f = await s.sample('/w', 6000);
    expect(f.value?.map((v) => v.mount)).toEqual(['/', '/w']);
    expect(f.unavailableMounts).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('keeps the I/O lock across stop() until the wedged call actually settles', async () => {
    const wedge = deferred<{ dev: number }>();
    const { s, stats } = make({ stat: async (p) => (p === '/w' ? wedge.promise : { dev: 1 }) });
    await s.sample('/w', 6000);
    await flush();
    s.stop();
    expect(vi.getTimerCount()).toBe(0); // pending timeout timers cancelled
    t = 60_000;
    await s.sample('/w', 6000); // still locked: no duplicate job may start
    expect(stats.filter((p) => p === '/w')).toHaveLength(1);
    s.stop();
    wedge.resolve({ dev: 2 });
    await flush();
    let f = await s.sample('/w', 6000); // settled-but-aborted write is discarded
    expect(f.unavailableMounts).toEqual(['/w']);
    t += 2000;
    await s.sample('/w', 6000); // lock released on settle: due -> relaunch
    expect(stats.filter((p) => p === '/w')).toHaveLength(2);
    await flush();
    f = await s.sample('/w', 6000);
    expect(f.value?.map((v) => v.mount)).toEqual(['/', '/w']);
  });

  it('forwards the sample signal into the job: abort discards results and the timer', async () => {
    const wedge = deferred<{ dev: number }>();
    const { s, stats, statfss } = make({ stat: async (p) => (p === '/w' ? wedge.promise : { dev: 1 }) });
    const controller = new AbortController();
    await s.sample('/w', 6000, controller.signal);
    await flush();
    controller.abort();
    await flush();
    expect(vi.getTimerCount()).toBe(0); // the volume timeout dies with the parent
    t = 60_000;
    await s.sample('/w', 6000); // still I/O-locked: no duplicate job
    expect(stats.filter((p) => p === '/w')).toHaveLength(1);
    wedge.resolve({ dev: 2 });
    await flush();
    expect(statfss).not.toContain('/w'); // the late stat never reached statfs
    t += 2000;
    await s.sample('/w', 6000); // settled: a new generation may run
    expect(stats.filter((p) => p === '/w')).toHaveLength(2);
  });

  it.each(['timeout', 'stop'] as const)(
    'marks retained numbers stale as soon as a refresh fails via %s', async (how) => {
      let wedged = false;
      const { s } = make({
        stat: async (p) => {
          if (p === '/w' && wedged) return new Promise<{ dev: number }>(() => {});
          return { dev: p === '/' ? 1 : 2 };
        },
      });
      await s.sample('/w', 30_000); // success at t0, period 10s
      await flush();
      wedged = true;
      t = 10_000; // both volumes due; '/w' refresh hangs, root's completes
      await s.sample('/w', 30_000);
      await flush();
      t = 13_000;
      if (how === 'timeout') await vi.advanceTimersByTimeAsync(3100);
      else s.stop();
      t = 14_000; // well inside the original 30s ttl
      const f = await s.sample('/w', 30_000);
      const cwd = f.value?.find((v) => v.mount === '/w');
      expect(cwd?.status).toBe('stale'); // failed refresh -> stale immediately
      expect(cwd?.total).toBe(40960);    // numbers retained, never fabricated
      expect(f.value?.find((v) => v.mount === '/')?.status).toBe('ok');
      // 根卷刚刷新成功：父事实保持 ok，且元数据只聚合新鲜卷
      expect(f.status).toBe('ok');
      expect(f.observedAt).toBe(10_000);
    },
  );

  it('aggregates parent metadata only over fresh volumes', async () => {
    const { s } = make({
      stat: async (p) => ({ dev: p === '/' ? 1 : p === '/a' ? 2 : 3 }),
    });
    await s.sample('/a', 6000); // '/'、'/a' 于 t=0 落盘，ttl 6000
    await flush();
    t = 2000;
    await s.sample('/b', 30_000); // 新挂载点 '/b' 于 t=2000 落盘，ttl 30s
    await flush();
    let f = await s.sample('/b', 30_000);
    expect(f.status).toBe('ok');
    expect(f.value?.map((v) => v.mount)).toEqual(['/', '/b']);
    expect(f.observedAt).toBe(0);   // 最旧新鲜观察
    expect(f.ttlMs).toBe(6000);     // 最早新鲜过期 6000 − 最旧观察 0
    t = 6500; // '/' 越过 6000 截止 -> stale；'/b' 仍新鲜
    f = await s.sample('/b', 30_000);
    expect(f.status).toBe('ok');    // 有新鲜兄弟卷，父事实不降级
    expect(f.value?.find((v) => v.mount === '/')?.status).toBe('stale');
    expect(f.observedAt).toBe(2000); // stale 根卷的更旧时间戳不进入父元数据
    expect(f.ttlMs).toBe(30_000);    // 最早新鲜过期 32_000 − 观察 2000
    t = 33_000; // '/b' 也越过 32_000 截止 -> 全部失鲜
    f = await s.sample('/b', 30_000);
    expect(f.status).toBe('stale');
    expect(f.observedAt).toBe(0);    // 无新鲜卷时回落到全部记录元数据
  });

  it('keeps sampler-produced stale and unreadable volumes out of floor transitions', async () => {
    let failRoot = false;
    const { s } = make({
      statfs: async (p) => {
        if (p === '/' && failRoot) throw new Error('not readable');
        return { bsize: 1, blocks: 100, bavail: p === '/' ? 2 : 90 };
      },
    });
    await s.sample('/data', 30000);
    await flush();
    failRoot = true;
    t = 10000;
    await s.sample('/data', 30000);
    await flush();
    const disk = await s.sample('/data', 30000);
    expect(disk.kind).toBe('disks');
    expect(disk.value).toMatchObject([{ mount: '/', status: 'stale' }, { mount: '/data', status: 'ok' }]);
    const source: SourceRef = { id: 'test', api: 'fixture', host: 'fake' };
    const missing: Fact<never> = { value: null, status: 'unknown', source, observedAt: 0, ttlMs: 1 };
    const body: Body = {
      cpu: missing, memory: missing, disks: disk, battery: missing, thermal: missing,
      network: missing, harnessProcess: missing, tokens: missing,
    };
    const previous = { body: { ...body, disks: { ...missing, kind: 'disks' as const } }, at: 0, monotonicAt: 0, source };
    const next = { body, at: t, monotonicAt: t, source };
    expect(bodyThresholdSignals(previous, next).signals).toEqual([]);
    const held = bodyThresholdSignals({ ...previous, state: { 'disk:/': 'critical' } }, next);
    expect(held.signals).toEqual([]);
    expect(held.state['disk:/']).toBe('critical');
    s.stop();
  });

  it('expires disk volumes at the exact half-open TTL deadline', async () => {
    const { s } = make();
    await s.sample('/w', 6000);
    await flush();
    t = 6000;
    const result = await s.sample('/w', 6000);
    expect(result.status).toBe('stale');
    expect(result.value?.map((v) => v.status)).toEqual(['stale', 'stale']);
    s.stop();
    await flush();
  });

  it('marks retained numbers stale on a rejected refresh too', async () => {
    let fail = false;
    const { s } = make({
      statfs: async (p) => {
        if (p === '/w' && fail) throw new Error('gone');
        return { bsize: 4096, blocks: 10, bavail: 5 };
      },
    });
    await s.sample('/w', 30_000);
    await flush();
    fail = true;
    t = 10_000;
    await s.sample('/w', 30_000);
    await flush();
    const f = await s.sample('/w', 30_000); // inside ttl but the failure is known
    expect(f.value?.find((v) => v.mount === '/w')?.status).toBe('stale');
    expect(f.value?.find((v) => v.mount === '/')?.status).toBe('ok');
  });

  it('keeps the original read ttl/deadline across restarts and wider cadences', async () => {
    const { s } = make();
    await s.sample('/w', 6000);
    await flush();
    s.stop();
    t = 7000; // original 6s deadline passed; a wider caller ttl must not revive it
    const f = await s.sample('/w', 90_000);
    const cwd = f.value?.find((v) => v.mount === '/w');
    expect(cwd?.ttlMs).toBe(6000);   // the read keeps its own ttl
    expect(cwd?.status).toBe('stale');
    expect(f.status).toBe('stale');
  });

  it('queries each distinct path once; cwd "/" collapses to a single job and equal devs dedup', async () => {
    const { s, stats } = make({ stat: async () => ({ dev: 1 }) });
    await s.sample('/', 6000);
    await flush();
    expect(stats).toEqual(['/']);
    const f = await s.sample('/', 6000);
    expect(f.value?.map((v) => v.mount)).toEqual(['/']);
    await s.sample('/w', 6000);
    await flush();
    const f2 = await s.sample('/w', 6000);
    expect(f2.value?.map((v) => v.mount)).toEqual(['/']); // same dev: root wins
    expect(f2.unavailableMounts).toBeUndefined();
  });

  it('omits and lists a failed volume without discarding others, then recovers', async () => {
    let fail = true;
    const { s } = make({
      statfs: async (p) => {
        if (p === '/w' && fail) throw new Error('gone');
        return { bsize: 4096, blocks: 10, bavail: 5 };
      },
    });
    await s.sample('/w', 6000);
    await flush();
    const f = await s.sample('/w', 6000);
    expect(f.status).toBe('ok');
    expect(f.value?.map((v) => v.mount)).toEqual(['/']);
    expect(f.unavailableMounts).toEqual(['/w']);
    fail = false;
    t = 2000;
    await s.sample('/w', 6000);
    await flush();
    const f2 = await s.sample('/w', 6000);
    expect(f2.value?.map((v) => v.mount)).toEqual(['/', '/w']);
    expect(f2.unavailableMounts).toBeUndefined();
  });

  it('marks volumes and the aggregate fact stale past their tracked deadline', async () => {
    const { s } = make();
    await s.sample('/w', 6000);
    await flush();
    t = 7000; // past the 6s deadline (period 2000 * 3)
    const f = await s.sample('/w', 6000); // republishes last values while relaunching
    expect(f.status).toBe('stale');
    expect(f.value?.every((v) => v.status === 'stale')).toBe(true);
    expect(f.value?.map((v) => v.total)).toEqual([40960, 40960]); // numbers retained
    await flush();
    const f2 = await s.sample('/w', 6000); // refreshed reads land
    expect(f2.status).toBe('ok');
    expect(f2.value?.every((v) => v.status === 'ok')).toBe(true);
    expect(f2.observedAt).toBe(7000); // refreshed reads carry their own observation
  });
});
