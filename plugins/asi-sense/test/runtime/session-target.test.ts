import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DshPort, SessionRow, StoragePort } from '../../src/host/runtime/ports.ts';
import { createSessionTarget } from '../../src/host/runtime/session-target.ts';

function fixture(initial?: string, onClosed?: (id: string) => Promise<void>) {
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
  let listGate: Promise<void> | undefined;
  let saveGate: Promise<void> | undefined;
  let saving = false;
  const applied: Array<string | undefined> = [];
  let resets = 0;
  const port: Pick<DshPort, 'listSessions' | 'ensureSession' | 'onSessionsChanged'> = {
    listSessions: async () => {
      if (failList) throw new Error('list unavailable');
      const listed = rows;
      await listGate;
      return listed;
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
      saving = true;
      await saveGate;
      data.set(key, value);
      saving = false;
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
    onClosed ? { closed: onClosed, refreshed: () => {} } : undefined,
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
    holdList: (value: Promise<void>) => {
      listGate = value;
    },
    holdSave: (value: Promise<void>) => {
      saveGate = value;
    },
    saving: () => saving,
    notify: () => notify(),
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
  it('resets a closed target without waiting for recovery and ignores its late completion', async () => {
    const h = fixture();
    let release = () => {};
    let finished = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.target.start();
    await h.target.select('b');
    h.target.unload('b');
    h.ensure(async () => {
      await gate;
      finished = true;
    });
    const recovery = h.target.ensure();
    await Promise.resolve();
    h.close('b');
    try {
      expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
      expect(h.resets).toBe(1);
      release();
      await recovery;
      await vi.waitFor(() => expect(finished).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await h.target.settled();
      expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
      expect(h.applied).toEqual(['b', undefined]);
      expect(h.data.get('target-fixture')).toContain('"sessionId":null');
    } finally {
      release();
      await h.target.stop();
    }
  });

  it('does not start a restoration cancelled by an immediate close', async () => {
    const h = fixture();
    let attempts = 0;
    await h.target.start();
    await h.target.select('b');
    h.target.unload('b');
    h.ensure(async () => {
      attempts++;
    });
    h.target.ensure();
    h.close('b');
    await h.target.settled();
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
    expect(attempts).toBe(0);
    await h.target.stop();
  });

  it('does not block startup on a hung restoration and retries after a timeout', async () => {
    vi.useFakeTimers();
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'b' }));
    let attempts = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ensure(() => {
      attempts++;
      return gate;
    });
    let started = false;
    const start = h.target.start().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'b', unavailable: true });
    expect(h.data.get('target-fixture')).toContain('"b"');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toEqual([]);
    h.ensure(() => {
      attempts++;
      return new Promise<void>(() => {});
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'b', unavailable: true });
    await start;
    await h.target.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('processes closure immediately while an older session list is blocked', async () => {
    const h = fixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.target.start();
    await h.target.select('b');
    h.holdList(gate);
    h.notify();
    await Promise.resolve();
    await Promise.resolve();
    h.close('b');
    try {
      expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
      await vi.waitFor(() => expect(h.data.get('target-fixture')).toContain('"sessionId":null'));
      expect(h.resets).toBe(1);
    } finally {
      release();
      await h.target.settled();
      await h.target.stop();
    }
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
    expect(h.target.snapshot().sessions.map((row) => row.id)).not.toContain('b');
    expect(h.applied).toEqual(['b', undefined]);
  });

  it('does not block startup on a hung session list', async () => {
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'b' }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.holdList(gate);
    await h.target.start();
    await Promise.resolve();
    h.close('b');
    await Promise.resolve();
    expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
    release();
    await h.target.settled();
    await h.target.stop();
    expect(h.applied).toEqual([undefined]);
  });

  it('does not block shutdown on a hung session list', async () => {
    vi.useFakeTimers();
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'b' }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.holdList(gate);
    await h.target.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = h.target.stop().then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await stop;
    }
  });

  it.each(['list', 'ensure'] as const)(
    'returns to auto when %s reports the target missing even if close handling is blocked',
    async (missing) => {
      vi.useFakeTimers();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = fixture(JSON.stringify({ version: 1, sessionId: missing === 'list' ? 'gone' : 'b' }), () => gate);
      if (missing === 'ensure') {
        h.ensure(async () => {
          throw Object.assign(new Error('missing'), { code: 'session/not-found' });
        });
      }
      await h.target.start();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
        expect(h.applied).toEqual([undefined]);
      } finally {
        release();
        await vi.advanceTimersByTimeAsync(0);
        await h.target.stop();
      }
    },
  );

  it('does not treat a stale list as evidence that an unrelated target is missing', async () => {
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'b' }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.holdList(gate);
    await h.target.start();
    await Promise.resolve();
    h.close('a');
    release();
    await h.target.settled();
    await vi.waitFor(() => expect(h.applied).toEqual(['b']));
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'b' });
    expect(h.resets).toBe(0);
    await h.target.stop();
  });

  it('does not start an old startup restoration after the user requests a different target', async () => {
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'b' }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: string[] = [];
    h.holdList(gate);
    h.ensure(async (id) => {
      attempts.push(id);
    });
    await h.target.start();
    const selection = h.target.select('a');
    release();
    await selection;
    await Promise.resolve();
    expect(attempts).toEqual(['a']);
    expect(h.applied).toEqual(['a']);
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'a' });
    await h.target.stop();
  });

  it('keeps a close authoritative when a newer selection is already being saved', async () => {
    const h = fixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.target.start();
    await h.target.select('a');
    h.holdSave(gate);
    const selection = h.target.select('b');
    const rejected = expect(selection).rejects.toThrow('target selection superseded');
    await vi.waitFor(() => expect(h.saving()).toBe(true));
    h.close('a');
    try {
      expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true });
      release();
      await rejected;
      await h.target.settled();
      expect(h.data.get('target-fixture')).toContain('"sessionId":null');
      expect(h.applied).toEqual(['a', undefined]);
      expect(h.resets).toBe(1);
    } finally {
      release();
      await h.target.stop();
    }
  });

  it('retries the old pinned target if a replacement selection fails during recovery', async () => {
    vi.useFakeTimers();
    const h = fixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.target.start();
    await h.target.select('b');
    h.target.unload('b');
    let attempts = 0;
    h.ensure(async (id) => {
      if (id === 'a') throw new Error('selection failed');
      attempts++;
      if (attempts === 1) await gate;
    });
    h.target.ensure();
    await vi.advanceTimersByTimeAsync(0);
    await expect(h.target.select('a')).rejects.toThrow('selection failed');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toEqual(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    expect(h.applied).toEqual(['b', 'b']);
    expect(h.target.snapshot()).toMatchObject({ mode: 'pinned', sessionId: 'b' });
    await h.target.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues startup and clears a target removed between listing and restoration', async () => {
    const h = fixture(JSON.stringify({ version: 1, sessionId: 'a' }));
    h.ensure(async (id) => {
      h.remove(id);
      throw Object.assign(new Error('not found'), { code: 'session/not-found' });
    });
    await expect(h.target.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.data.get('target-fixture')).toContain('"sessionId":null'));
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
    await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
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
    await vi.waitFor(() => expect(second.applied).toEqual(['a']));
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
    await vi.waitFor(() => expect(h.target.snapshot()).toMatchObject({ mode: 'auto', notice: true }));
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
