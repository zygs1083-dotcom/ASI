import { type Fact, factStatusAt } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../../src/sense/host/state/store.ts';
import { FakeClock, SRC, sig } from './helpers.ts';

function storeAt(clock: FakeClock) {
  return new StateStore(clock.time, 1000);
}

describe('factStatusAt', () => {
  it('flips ok to stale only at observedAt+ttlMs and preserves other statuses', () => {
    const f: Fact<number> = {
      value: 1,
      status: 'ok',
      source: SRC,
      observedAt: 100,
      ttlMs: 50,
    };
    expect(factStatusAt(f, 149)).toBe('ok');
    expect(factStatusAt(f, 150)).toBe('stale');
    expect(factStatusAt({ ...f, status: 'denied' }, 10_000)).toBe('denied');
  });
});

describe('StateStore', () => {
  it('retains valid foreground pid and window count and drops them on the next app', () => {
    const store = storeAt(new FakeClock());
    store.apply(
      sig({
        id: 'front-1',
        kind: 'app.activated',
        data: { name: 'Fixture', bundleId: 'fixture.app', pid: 123, windowCount: 0 },
      }),
    );
    expect(store.snapshot().env.frontApp.value).toEqual({
      name: 'Fixture',
      bundleId: 'fixture.app',
      pid: 123,
      windowCount: 0,
    });
    store.apply(
      sig({
        id: 'front-2',
        kind: 'app.activated',
        data: { name: 'Other', bundleId: 'other.app', pid: -1, windowCount: -1 },
      }),
    );
    expect(store.snapshot().env.frontApp.value).toEqual({ name: 'Other', bundleId: 'other.app' });
  });

  it('preserves a fact reason and clears it on a subsequent observation without one', () => {
    const store = storeAt(new FakeClock());
    store.apply(
      sig({
        id: 'missing-token',
        kind: 'fact.updated',
        data: { path: 'self.body.tokens', value: null, status: 'unavailable', reason: 'fixture reason' },
      }),
    );
    expect(store.snapshot().self.body.tokens.reason).toBe('fixture reason');
    store.apply(
      sig({
        id: 'new-token',
        kind: 'fact.updated',
        data: {
          path: 'self.body.tokens',
          value: { sessionUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        },
      }),
    );
    expect(store.snapshot().self.body.tokens.reason).toBeUndefined();
  });

  it('accepts new same-source samples after wall rollback and expires from receipt time', () => {
    const clock = new FakeClock();
    clock.wall = 100_000;
    const store = new StateStore(clock.wallTime, 1_000, clock.time);
    const cpu = (id: string, usage: number, sequence?: number) =>
      sig({
        id,
        kind: 'fact.updated',
        at: clock.wall,
        data: {
          path: 'self.body.cpu',
          value: { usage },
          ttlMs: 1_000,
          ...(sequence === undefined ? {} : { sequence }),
        },
      });
    store.apply(cpu('first', 0.1));
    clock.advance(500);
    clock.jumpWall(-10_500);
    store.apply(cpu('new', 0.9));
    expect(store.snapshot().self.body.cpu).toMatchObject({ value: { usage: 0.9 }, observedAt: 90_000, status: 'ok' });
    clock.advance(999);
    expect(store.snapshot().self.body.cpu.status).toBe('ok');
    clock.advance(1);
    expect(store.snapshot().self.body.cpu.status).toBe('stale');
    store.apply(cpu('seq-2', 0.8, 2));
    store.apply(cpu('seq-1', 0.2, 1));
    expect(store.snapshot().self.body.cpu.value).toMatchObject({ usage: 0.8 });
  });

  it('uses receipt order for job samples, job events and source health after wall rollback', () => {
    const clock = new FakeClock();
    clock.wall = 100_000;
    const store = new StateStore(clock.wallTime, 1_000, clock.time);
    store.apply(sig({ id: 'first', kind: 'fact.updated', at: 100_000, data: { path: 'env.activeJobs', value: [] } }));
    clock.wall = 90_000;
    clock.now = 500;
    store.apply(sig({ id: 'started', kind: 'job.started', at: 90_000, subject: 'new-job' }));
    expect(store.snapshot().env.activeJobs.value?.map((job) => job.id)).toEqual(['new-job']);
    store.apply(
      sig({
        id: 'second',
        kind: 'fact.updated',
        at: 89_000,
        data: {
          path: 'env.activeJobs',
          value: [{ id: 'sampled-job', status: 'running', startedAt: 89_000 }],
        },
      }),
    );
    expect(store.snapshot().env.activeJobs).toMatchObject({
      value: [{ id: 'sampled-job' }],
      observedAt: 89_000,
      status: 'ok',
    });
    store.apply(sig({ id: 'source-error', kind: 'source.error', at: 88_000, data: { error: 'fixture' } }));
    expect(store.snapshot().observation.sources.fs).toMatchObject({ status: 'unavailable', lastSignalAt: 88_000 });
    clock.now += 1_000;
    expect(store.snapshot().env.activeJobs.status).toBe('stale');
  });

  it('does not advance a fact sequence on an invalid sample or compare different sources', () => {
    const store = storeAt(new FakeClock());
    const update = (id: string, sequence: number, value?: number, source = SRC) =>
      sig({
        id,
        kind: 'fact.updated',
        at: 0,
        source,
        data: { path: 'self.body.cpu', sequence, ...(value === undefined ? {} : { value: { usage: value } }) },
      });
    store.apply(update('one', 1, 0.1));
    store.apply(update('invalid', 99));
    store.apply(update('two', 2, 0.9));
    expect(store.snapshot().self.body.cpu.value).toMatchObject({ usage: 0.9 });
    store.apply(update('other-source', 1, 0.5, { id: 'other', api: 'test', host: 'local' }));
    expect(store.snapshot().self.body.cpu.value).toMatchObject({ usage: 0.5 });
  });

  it('does not refresh TTL or source health for an explicitly older job event', () => {
    const clock = new FakeClock();
    clock.wall = 100_000;
    const store = new StateStore(clock.wallTime, 1_000, clock.time);
    store.apply(sig({ id: 'new-job', kind: 'job.started', subject: 'job', at: clock.wall, data: { sequence: 10 } }));
    store.apply(sig({ id: 'error', kind: 'source.error', at: clock.wall, data: { error: 'fixture' } }));
    clock.now = 500;
    store.apply(sig({ id: 'old-job', kind: 'job.started', subject: 'job', at: clock.wall, data: { sequence: 5 } }));
    expect(store.snapshot().observation.sources.fs?.status).toBe('unavailable');
    clock.now = 1_000;
    expect(store.snapshot().env.activeJobs.status).toBe('stale');
  });

  it('retains comparable job snapshot sequences independently per source', () => {
    const store = storeAt(new FakeClock());
    const other = { id: 'other', api: 'test', host: 'local' };
    store.apply(sig({ id: 'a10', kind: 'fact.updated', data: { path: 'env.activeJobs', value: [], sequence: 10 } }));
    store.apply(
      sig({
        id: 'b1',
        kind: 'fact.updated',
        source: other,
        data: { path: 'env.activeJobs', value: [], sequence: 1 },
      }),
    );
    store.apply(sig({ id: 'old', kind: 'job.started', subject: 'job', data: { sequence: 9 } }));
    expect(store.snapshot().env.activeJobs.value).toEqual([]);
    store.apply(sig({ id: 'new', kind: 'job.started', subject: 'job', data: { sequence: 11 } }));
    expect(store.snapshot().env.activeJobs.value?.map((job) => job.id)).toEqual(['job']);
  });

  it('compares per-job sequences from the same source across intervening sources', () => {
    const store = storeAt(new FakeClock());
    const other = { id: 'other', api: 'test', host: 'local' };
    store.apply(sig({ id: 'a10', kind: 'job.started', subject: 'job', data: { sequence: 10 } }));
    store.apply(sig({ id: 'b1', kind: 'job.started', subject: 'job', source: other, data: { sequence: 1 } }));
    store.apply(sig({ id: 'a5', kind: 'job.exited', subject: 'job', data: { sequence: 5 } }));
    expect(store.snapshot().env.activeJobs.value?.map((job) => job.id)).toEqual(['job']);
  });

  it('uses monotonic receipt time for live TTL after wall-clock rollback', () => {
    const clock = new FakeClock();
    const store = new StateStore(clock.wallTime, 1_000, clock.time);
    store.apply(sig({ id: 'app', kind: 'app.activated', at: 0, data: { name: 'Example' } }));
    clock.jumpWall(-10_000);
    clock.now += 1_000;
    expect(store.snapshot().env.frontApp.status).toBe('stale');
  });
  it('initializes every fact unknown/null with the internal source', () => {
    const clock = new FakeClock();
    const s = storeAt(clock).snapshot();
    expect(s.env.frontApp).toMatchObject({
      value: null,
      status: 'unknown',
      observedAt: 0,
    });
    expect(s.env.frontApp.source).toEqual({
      id: 'asi-sense',
      api: 'state',
      host: 'local',
    });
    expect(s.self.body.battery.status).toBe('unknown');
  });

  it('applies typed signals to env/self sections', () => {
    const c = new FakeClock();
    const st = storeAt(c);
    st.apply(
      sig({
        id: '1',
        kind: 'app.activated',
        at: 10,
        data: { name: 'Safari', bundleId: 'com.apple.Safari' },
      }),
    );
    st.apply(
      sig({
        id: '2',
        kind: 'window.title-changed',
        at: 11,
        data: { title: 'Doc' },
      }),
    );
    st.apply(sig({ id: '3', kind: 'file.changed', at: 12, subject: '/r/a.ts' }));
    st.apply(sig({ id: '4', kind: 'file.changed', at: 13, subject: '/r/a.ts' }));
    st.apply(
      sig({
        id: '5',
        kind: 'job.started',
        at: 14,
        subject: 'j1',
        data: { command: 'pnpm test', pid: 9 },
      }),
    );
    st.apply(
      sig({
        id: '6',
        kind: 'agent.status',
        at: 15,
        data: { activity: 'tool' },
      }),
    );
    const s = st.snapshot();
    expect(s.env.frontApp.value).toEqual({
      name: 'Safari',
      bundleId: 'com.apple.Safari',
    });
    expect(s.env.focusedWindow.value).toEqual({ title: 'Doc' });
    expect(s.env.activeJobs.value).toEqual([
      {
        id: 'j1',
        startedAt: 14,
        command: 'pnpm test',
        pid: 9,
        status: 'running',
      },
    ]);
    expect(s.self.activity.value).toBe('tool');
    st.apply(
      sig({
        id: '7',
        kind: 'job.exited',
        at: 16,
        subject: 'j1',
        data: { exitCode: 1 },
      }),
    );
    expect(st.snapshot().env.activeJobs.value).toEqual([]);
  });

  it('updates every fact section via fact.updated', () => {
    const st = storeAt(new FakeClock());
    const upd = (path: string, value: unknown) =>
      st.apply(
        sig({
          id: `u-${path}`,
          kind: 'fact.updated',
          at: 20,
          data: { path, value },
        }),
      );
    upd('self.pending', { inbox: 2, jobs: 1 });
    upd('self.tools', ['fs.read']);
    upd('self.permissions', { ax: 'granted' });
    upd('self.body.memory', {
      total: 1,
      used: 1,
      pressure: 'warn',
      swapUsed: 0,
    });
    upd('self.body.disks', [{ mount: '/', total: 100, free: 5 }]);
    upd('self.body.tokens', {
      contextWindow: 10,
      contextUsed: 9,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    upd('env.where.model', { provider: 'p', endpoint: 'e', local: true });
    upd('env.where.toolExec', { host: 'h', cwd: '/r' });
    upd('env.activeJobs', [{ id: 'x', startedAt: 1, status: 'running' }]);
    const s = st.snapshot();
    expect(s.self.pending.value).toEqual({ inbox: 2, jobs: 1 });
    expect(s.self.tools.value).toEqual(['fs.read']);
    expect(s.self.permissions.value).toEqual({ ax: 'granted' });
    expect(s.self.body.memory.value?.pressure).toBe('warn');
    expect(s.self.body.disks.value?.[0].mount).toBe('/');
    expect(s.self.body.tokens.value?.contextWindow).toBe(10);
    expect(s.env.where.model.value?.local).toBe(true);
    expect(s.env.where.toolExec.value?.cwd).toBe('/r');
    expect(s.env.activeJobs.value?.[0].id).toBe('x');
  });

  it('rejects unknown and prototype paths in fact.updated', () => {
    const st = storeAt(new FakeClock());
    for (const path of ['__proto__.x', 'env.frontApp.x', 'self.body', 'constructor']) {
      st.apply(
        sig({
          id: `p-${path}`,
          kind: 'fact.updated',
          at: 1,
          data: { path, value: 1 },
        }),
      );
    }
    const s = st.snapshot();
    expect(s.env.frontApp.value).toBeNull();
    expect(s.self.body.battery.value).toBeNull();
  });

  it('honours signal ttlMs and computes stale at boundary in snapshots', () => {
    const c = new FakeClock();
    const st = storeAt(c);
    st.apply(sig({ id: '1', kind: 'app.activated', at: 0, data: { name: 'A' } })); // default ttl 1000
    st.apply(
      sig({
        id: '2',
        kind: 'fact.updated',
        at: 0,
        data: { path: 'env.focusedWindow', value: { title: 'T' }, ttlMs: 5 },
      }),
    );
    expect(st.snapshot(4).env.focusedWindow.status).toBe('ok');
    expect(st.snapshot(5).env.focusedWindow.status).toBe('stale');
    expect(st.snapshot(999).env.frontApp.status).toBe('ok');
    expect(st.snapshot(1000).env.frontApp.status).toBe('stale');
    // status preservation: denied stays denied past ttl
    st.apply(
      sig({
        id: '3',
        kind: 'fact.updated',
        at: 2,
        data: { path: 'env.frontApp', value: null, status: 'denied', ttlMs: 1 },
      }),
    );
    expect(st.snapshot(10_000).env.frontApp.status).toBe('denied');
  });

  it('returns isolated deep clones; mutations cannot affect internal state', () => {
    const st = storeAt(new FakeClock());
    st.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'A' } }));
    const a = st.snapshot();
    const b = st.snapshot();
    expect(a).not.toBe(b);
    if (a.env.frontApp.value) a.env.frontApp.value.name = 'HACK';
    expect(st.snapshot().env.frontApp.value?.name).toBe('A');
  });

  it('notifies subscribers with fresh snapshots and supports unsubscribe', () => {
    const st = storeAt(new FakeClock());
    const seen: string[] = [];
    const off = st.subscribe((s) => seen.push(s.env.frontApp.value?.name ?? '?'));
    st.apply(sig({ id: '1', kind: 'app.activated', at: 1, data: { name: 'A' } }));
    off();
    st.apply(sig({ id: '2', kind: 'app.activated', at: 2, data: { name: 'B' } }));
    expect(seen).toEqual(['A']);
  });

  it('ignores earlier explicit sequences per fact while keeping independent fact keys isolated', () => {
    const st = storeAt(new FakeClock());
    st.apply(sig({ id: '1', kind: 'app.activated', at: 10, data: { name: 'New', sequence: 10 } }));
    st.apply(sig({ id: '2', kind: 'app.activated', at: 5, data: { name: 'Old', sequence: 5 } }));
    expect(st.snapshot().env.frontApp.value?.name).toBe('New');
    st.apply(sig({ id: '3', kind: 'window.title-changed', at: 8, data: { title: 'Win', sequence: 8 } }));
    expect(st.snapshot().env.focusedWindow.value?.title).toBe('Win');
  });

  it('tracks source.status and source.error transitions in observation', () => {
    const st = storeAt(new FakeClock());
    st.apply(
      sig({
        id: '1',
        kind: 'source.status',
        at: 1,
        source: SRC,
        data: { status: 'denied', error: 'ax off' },
      }),
    );
    expect(st.snapshot().observation.sources.fs).toEqual({
      status: 'denied',
      lastSignalAt: 1,
      error: 'ax off',
    });
    st.apply(
      sig({
        id: '2',
        kind: 'source.error',
        at: 2,
        source: SRC,
        data: { error: 'boom' },
      }),
    );
    expect(st.snapshot().observation.sources.fs).toEqual({
      status: 'unavailable',
      lastSignalAt: 2,
      error: 'boom',
    });
    st.apply(
      sig({
        id: '3',
        kind: 'app.activated',
        at: 3,
        source: SRC,
        data: { name: 'A' },
      }),
    );
    expect(st.snapshot().observation.sources.fs).toEqual({
      status: 'ok',
      lastSignalAt: 3,
    });
  });

  it('tracks env.system lock, sleep, wake timestamps, long TTL, and independent lock/power ordering', () => {
    let wall = 1_000;
    const st = new StateStore(
      () => wall,
      60_000,
      () => wall,
    );
    expect(st.snapshot().env.system).toMatchObject({ status: 'unknown', value: null });

    st.apply(
      sig({ id: 'sys-1', kind: 'screen.locked', at: 1_000, subject: 'screen', data: { at: 1_000, sequence: 2 } }),
    );
    expect(st.snapshot().env.system?.status).toBe('ok');
    expect(st.snapshot().env.system?.value).toEqual({ locked: true });
    expect(st.snapshot().env.system?.ttlMs).toBeGreaterThanOrEqual(86_400_000);

    // Older power sequence does not collide with lock sequence; lock status stays intact.
    st.apply(
      sig({ id: 'sys-2', kind: 'system.sleep', at: 2_000, subject: 'system', data: { at: 2_000, sequence: 1 } }),
    );
    expect(st.snapshot().env.system?.value).toEqual({ locked: true, lastSleepAt: 2_000 });

    // Stale unlock with older lock sequence (< 2) is ignored.
    st.apply(
      sig({ id: 'sys-stale', kind: 'screen.unlocked', at: 2_500, subject: 'screen', data: { at: 2_500, sequence: 1 } }),
    );
    expect(st.snapshot().env.system?.value?.locked).toBe(true);

    // Across an 8-hour sleep, env.system remains ok instead of expiring at defaultTtlMs (60s).
    wall = 28_802_000;
    expect(st.snapshot().env.system?.status).toBe('ok');

    st.apply(
      sig({
        id: 'sys-3',
        kind: 'system.wake',
        at: wall,
        subject: 'system',
        data: { at: wall, durationMs: 28_800_000, sequence: 2 },
      }),
    );
    expect(st.snapshot().env.system?.value).toEqual({
      locked: true,
      lastSleepAt: 2_000,
      lastWakeAt: 28_802_000,
    });

    st.apply(
      sig({
        id: 'sys-4',
        kind: 'screen.unlocked',
        at: 28_805_000,
        subject: 'screen',
        data: { at: 28_805_000, durationMs: 28_804_000, sequence: 3 },
      }),
    );
    expect(st.snapshot().env.system?.value).toEqual({
      locked: false,
      lastSleepAt: 2_000,
      lastWakeAt: 28_802_000,
    });

    // Explicit ttlMs override in data still honors expiry when specified.
    st.apply(
      sig({
        id: 'sys-5',
        kind: 'system.sleep',
        at: 28_806_000,
        subject: 'system',
        data: { at: 28_806_000, ttlMs: 100 },
      }),
    );
    wall = 28_806_150;
    expect(st.snapshot().env.system?.status).toBe('stale');
  });
});
