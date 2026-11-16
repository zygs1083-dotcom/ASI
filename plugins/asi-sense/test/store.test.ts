import { type Fact, factStatusAt } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/host/state/facts.ts';
import { StateStore } from '../src/host/state/store.ts';
import { noteFile } from '../src/host/state/updates.ts';
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
  it('uses monotonic receipt time for live TTL after wall-clock rollback', () => {
    const clock = new FakeClock();
    const store = new StateStore(clock.wallTime, 1_000, clock.time);
    store.apply(sig({ id: 'app', kind: 'app.activated', at: 0, data: { name: 'Example' } }));
    clock.jumpWall(-10_000);
    clock.now += 1_000;
    expect(store.snapshot().env.frontApp.status).toBe('stale');
  });
  it('bounds watched paths at 5000 and evicts the least recently used path', () => {
    const state = initialState(0, 60_000);
    for (let i = 0; i < 5000; i++)
      noteFile(state, sig({ id: String(i), kind: 'file.changed', subject: `/f/${i}`, at: i }), 60_000);
    noteFile(state, sig({ id: 'touch', kind: 'file.changed', subject: '/f/0', at: 5000 }), 60_000);
    noteFile(state, sig({ id: 'new', kind: 'file.changed', subject: '/f/new', at: 5001 }), 60_000);
    expect(Object.keys(state.env.watchedPaths.value ?? {})).toHaveLength(5000);
    expect(state.env.watchedPaths.value?.['/f/0']).toBeDefined();
    expect(state.env.watchedPaths.value?.['/f/1']).toBeUndefined();
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
    expect(s.env.watchedPaths.value?.['/r/a.ts']).toEqual({
      lastChange: 13,
      changes: 2,
    });
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
    a.env.watchedPaths.value = { '/evil': { lastChange: 0, changes: 9 } };
    expect(st.snapshot().env.frontApp.value?.name).toBe('A');
    expect(st.snapshot().env.watchedPaths.value).toBeNull();
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

  it('ignores out-of-order signals per fact but allows older distinct file paths', () => {
    const st = storeAt(new FakeClock());
    st.apply(sig({ id: '1', kind: 'app.activated', at: 10, data: { name: 'New' } }));
    st.apply(sig({ id: '2', kind: 'app.activated', at: 5, data: { name: 'Old' } }));
    expect(st.snapshot().env.frontApp.value?.name).toBe('New');
    st.apply(sig({ id: '3', kind: 'file.changed', at: 10, subject: '/r/a' }));
    st.apply(sig({ id: '4', kind: 'file.changed', at: 8, subject: '/r/b' }));
    st.apply(sig({ id: '5', kind: 'file.changed', at: 9, subject: '/r/a' }));
    const w = st.snapshot().env.watchedPaths.value ?? {};
    expect(w['/r/a']).toEqual({ lastChange: 10, changes: 1 });
    expect(w['/r/b']).toEqual({ lastChange: 8, changes: 1 });
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
});
