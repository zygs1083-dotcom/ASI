import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localPorts } from '../../src/host/dsh/local-ports.ts';

const fsMocks = vi.hoisted(() => ({
  watch: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  ...fsMocks,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('local file watcher timestamps', () => {
  it('uses fresh mtime for adds and modifications and callback time for old, missing or deleted files', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let emit!: (event: 'rename' | 'change', filename: string | null) => void;
    const close = vi.fn();
    fsMocks.watch.mockImplementation((_root, _options, cb) => {
      emit = cb;
      return { on: vi.fn(), close };
    });
    const events: unknown[] = [];
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const watcher = ports.files.watch('/workspace', (event) => events.push(event));
    vi.setSystemTime(11_000);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.lstatSync.mockReturnValue({ mtimeMs: 10_500 });
    emit('rename', 'new.txt');
    emit('change', 'new.txt');
    fsMocks.lstatSync.mockReturnValue({ mtimeMs: 9_000 });
    emit('change', 'old.txt');
    fsMocks.lstatSync.mockImplementation(() => {
      throw new Error('missing');
    });
    emit('change', 'missing.txt');
    fsMocks.existsSync.mockReturnValue(false);
    emit('rename', 'deleted.txt');
    expect(events).toEqual([
      { path: '/workspace/new.txt', change: 'add', at: 10_500 },
      { path: '/workspace/new.txt', change: 'modify', at: 10_500 },
      { path: '/workspace/old.txt', change: 'modify', at: 11_000 },
      { path: '/workspace/missing.txt', change: 'modify', at: 11_000 },
      { path: '/workspace/deleted.txt', change: 'delete', at: 11_000 },
    ]);
    watcher.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
