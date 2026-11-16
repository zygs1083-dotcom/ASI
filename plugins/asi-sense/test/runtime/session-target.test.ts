import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DshPort, SessionRow, StoragePort } from '../../src/host/runtime/ports.ts';
import { createSessionTarget } from '../../src/host/runtime/session-target.ts';

function fixture(initial?: string) {
  const data = new Map<string, string>(initial ? [['target-fixture', initial]] : []);
  let rows: SessionRow[] = [
    { id: 'a', title: 'First fixture', updatedAt: 1, running: false },
    { id: 'b', title: 'Second fixture', updatedAt: 2, running: false },
  ];
  let notify: (closed?: string) => void = () => {};
  let failList = false;
  let failLoad = false;
  let failSave = false;
  let failApply: string | undefined;
  let ensure: (id: string) => Promise<void> = async () => {};
  const applied: Array<string | undefined> = [];
  let resets = 0;
  const port: Pick<DshPort, 'listSessions' | 'ensureSession' | 'onSessionsChanged'> = {
    listSessions: async () => {
      if (failList) throw new Error('list unavailable');
      return rows;
    },
    ensureSession: (id) => ensure(id),
    onSessionsChanged: (cb) => {
      notify = cb;
      return () => {};
    },
  };
  const storage: StoragePort = {
    load: async (key) => {
      if (failLoad) throw new Error('load unavailable');
      return data.get(key);
    },
    save: async (key, value) => {
      if (failSave) throw new Error('save unavailable');
      data.set(key, value);
    },
  };
  const target = createSessionTarget(
    port,
    storage,
    'target-fixture',
    async (id) => {
      applied.push(id);
      if (id && failApply === id) throw new Error('apply unavailable');
    },
    () => {
      resets++;
    },
    () => {},
  );
  return {
    target,
    data,
    applied,
    get resets() {
      return resets;
    },
    failList: (value = true) => {
      failList = value;
    },
    failLoad: (value = true) => {
      failLoad = value;
    },
    failSave: () => {
      failSave = true;
    },
    failApply: (id: string | undefined) => {
      failApply = id;
    },
    ensure: (value: (id: string) => Promise<void>) => {
      ensure = value;
    },
    remove: (id: string) => {
      rows = rows.filter((row) => row.id !== id);
    },
    close: (id: string) => {
      rows = rows.filter((row) => row.id !== id);
      notify(id);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('session target persistence', () => {
  it('continues startup and clears a target removed between listing and restoration', async () => {
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'a' }));
    h.ensure(async (id) => {
      h.remove(id);
      throw Object.assign(new Error('not found'), { code: 'session/not-found' });
    });
    await expect(h.target.start()).resolves.toBeUndefined();
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
    expect(h.applied).toEqual([undefined]);
    expect(h.resets).toBe(1);
    expect(h.data.get('target-fixture')).toContain('"sessionId":null');
    await h.target.stop();
  });

  it('returns temporarily to auto when applying a restored selection fails', async () => {
    vi.useFakeTimers();
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'a' }));
    h.failApply('a');
    await expect(h.target.start()).resolves.toBeUndefined();
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'a', unavailable: true });
    expect(h.applied).toEqual(['a', undefined]);
    h.failApply(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.applied).toEqual(['a', undefined, 'a']);
    expect(h.target.snapshot().unavailable).toBeUndefined();
    await h.target.stop();
  });

  it.each(['list', 'ensure', 'load'] as const)(
    'retries a temporary %s failure without clearing the durable selection',
    async (failure) => {
      vi.useFakeTimers();
      const saved = JSON.stringify({ version: 1, sessionId: 'a' });
      const h = fixture(saved);
      if (failure === 'list') h.failList();
      if (failure === 'load') h.failLoad();
      if (failure === 'ensure')
        h.ensure(async () => {
          throw new Error('temporarily unavailable');
        });
      await expect(h.target.start()).resolves.toBeUndefined();
      expect(h.target.snapshot()).toMatchObject({ unavailable: true });
      if (failure !== 'load') expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
      expect(h.data.get('target-fixture')).toBe(saved);
      expect(h.applied).toEqual([]);
      h.failList(false);
      h.failLoad(false);
      h.ensure(async () => {});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
      expect(h.target.snapshot().unavailable).toBeUndefined();
      expect(h.applied).toEqual(['a']);
      expect(h.data.get('target-fixture')).toBe(saved);
      await h.target.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('persists a selection and restores it without storing a title', async () => {
    const first = fixture();
    await first.target.start();
    await first.target.select('a');
    const saved = first.data.get('target-fixture');
    expect(saved).not.toContain('First fixture');
    await first.target.stop();
    const second = fixture(saved);
    await second.target.start();
    expect(second.applied).toEqual(['a']);
    expect(second.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
    await second.target.stop();
  });

  it('falls back once when the pinned session closes', async () => {
    const h = fixture();
    await h.target.start();
    await h.target.select('a');
    h.close('a');
    await h.target.settled();
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
    expect(h.applied).toEqual(['a', undefined]);
    expect(h.resets).toBe(1);
    expect(h.data.get('target-fixture')).not.toContain('"a"');
    await h.target.stop();
  });

  it('falls back on restart if the saved session no longer exists', async () => {
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'gone' }));
    await h.target.start();
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
    expect(h.resets).toBe(1);
    await h.target.stop();
  });

  it('falls back when the close event arrives even if listing or persistence fails', async () => {
    const h = fixture();
    await h.target.start();
    await h.target.select('a');
    h.failList();
    h.failSave();
    h.close('a');
    await h.target.settled();
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true, unavailable: true });
    expect(h.applied).toEqual(['a', undefined]);
    expect(h.resets).toBe(1);
    await h.target.stop();
  });

  it('restores the prior target and durable choice when applying a new selection fails', async () => {
    const h = fixture();
    await h.target.start();
    await h.target.select('a');
    h.failApply('b');
    await expect(h.target.select('b')).rejects.toThrow('apply unavailable');
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
    expect(h.applied).toEqual(['a', 'b', 'a']);
    expect(h.data.get('target-fixture')).toContain('"a"');
    await h.target.stop();
  });
});
