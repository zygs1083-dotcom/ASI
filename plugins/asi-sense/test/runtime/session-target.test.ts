import { describe, expect, it } from 'vitest';
import type { DshPort, SessionRow, StoragePort } from '../../src/host/runtime/ports.ts';
import { createSessionTarget } from '../../src/host/runtime/session-target.ts';

function fixture(initial?: string) {
  const data = new Map<string, string>(initial ? [['target-fixture', initial]] : []);
  let rows: SessionRow[] = [
    { id: 'a', title: 'First fixture', updatedAt: 1, running: false },
    { id: 'b', title: 'Second fixture', updatedAt: 2, running: false },
  ];
  let notify: (closed?: string) => void = () => {};
  const applied: Array<string | undefined> = [];
  let resets = 0;
  const port: Pick<DshPort, 'listSessions' | 'ensureSession' | 'onSessionsChanged'> = {
    listSessions: async () => rows,
    ensureSession: async () => {},
    onSessionsChanged: (cb) => {
      notify = cb;
      return () => {};
    },
  };
  const storage: StoragePort = {
    load: async (key) => data.get(key),
    save: async (key, value) => {
      data.set(key, value);
    },
  };
  const target = createSessionTarget(
    port,
    storage,
    'target-fixture',
    async (id) => {
      applied.push(id);
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
    close: (id: string) => {
      rows = rows.filter((row) => row.id !== id);
      notify(id);
    },
  };
}

describe('session target persistence', () => {
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
});
