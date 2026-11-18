import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localPorts } from '../../src/host/dsh/local-ports.ts';

const fsMocks = vi.hoisted(() => ({
  watch: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  statSync: vi.fn(),
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
    fsMocks.statSync.mockReturnValue({ isDirectory: () => true });
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
    fsMocks.existsSync.mockImplementation((path: string) => path === '/workspace');
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

describe('missing file watcher roots', () => {
  it('watches the nearest existing ancestor, filters siblings, and switches when the target appears', () => {
    const paths = new Set(['/sandbox']);
    const callbacks = new Map<string, (event: 'rename' | 'change', filename: string | null) => void>();
    const closed: string[] = [];
    fsMocks.existsSync.mockImplementation((path: string) => paths.has(path));
    fsMocks.statSync.mockImplementation((path: string) => {
      if (!paths.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => true };
    });
    fsMocks.lstatSync.mockImplementation((path: string) => {
      if (!paths.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { mtimeMs: 0, isDirectory: () => true };
    });
    fsMocks.watch.mockImplementation((root: string, _options, cb) => {
      if (!paths.has(root)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      callbacks.set(root, cb);
      return { on: vi.fn(), close: () => closed.push(root) };
    });
    const events: string[] = [];
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const watcher = ports.files.watch('/sandbox/parent/target', (event) => events.push(event.path));
    expect([...callbacks.keys()]).toEqual(['/sandbox']);
    paths.add('/sandbox/sibling');
    callbacks.get('/sandbox')?.('rename', 'sibling');
    expect(events).toEqual([]);
    paths.add('/sandbox/parent');
    paths.add('/sandbox/parent/target');
    callbacks.get('/sandbox')?.('rename', 'parent/target');
    expect(closed).toContain('/sandbox');
    expect(callbacks.has('/sandbox/parent/target')).toBe(true);
    const beforeStale = [...events];
    callbacks.get('/sandbox')?.('rename', 'sibling');
    expect(events).toEqual(beforeStale);
    paths.add('/sandbox/parent/target/synthetic.txt');
    callbacks.get('/sandbox/parent/target')?.('change', 'synthetic.txt');
    expect(events).toContain('/sandbox/parent/target/synthetic.txt');
    watcher.close();
    expect(closed).toContain('/sandbox/parent/target');
  });

  it('passes a shallow-watch request through only at the target directory', () => {
    fsMocks.statSync.mockReturnValue({ isDirectory: () => true });
    fsMocks.watch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const shallow = ports.files.watch('/sandbox', () => {}, { recursive: false });
    expect(fsMocks.watch.mock.calls[0]?.[1]).toEqual({ recursive: false });
    shallow.close();
    fsMocks.watch.mockClear();
    const deep = ports.files.watch('/sandbox', () => {});
    expect(fsMocks.watch.mock.calls[0]?.[1]).toEqual({ recursive: true });
    deep.close();
  });

  it('keeps ancestor fallback watches recursive even for shallow subjects', () => {
    const existing = new Set(['/sandbox']);
    fsMocks.existsSync.mockImplementation((path: string) => existing.has(path));
    fsMocks.statSync.mockImplementation((path: string) => {
      if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => true };
    });
    fsMocks.watch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const watcher = ports.files.watch('/sandbox/a/b', () => {}, { recursive: false });
    // Ancestor fallback must stay recursive so the intermediate dirs'
    // appearance is still observed (delivered events stay inside the target).
    expect(fsMocks.watch.mock.calls[0]?.[0]).toBe('/sandbox');
    expect(fsMocks.watch.mock.calls[0]?.[1]).toEqual({ recursive: true });
    watcher.close();
  });

  it('reports an asynchronous native watcher error without fabricating a file change', () => {
    let fail!: () => void;
    fsMocks.statSync.mockReturnValue({ isDirectory: () => true });
    fsMocks.watch.mockReturnValue({
      on: (_event: string, callback: () => void) => {
        fail = callback;
      },
      close: vi.fn(),
    });
    const events: unknown[] = [];
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const watcher = ports.files.watch('/sandbox', (event) => events.push(event));
    fail();
    expect(events).toEqual([{ path: '/sandbox', change: 'modify', watchError: true }]);
    watcher.close();
    fail();
    expect(events).toHaveLength(1);
  });

  it('watches the parent directory when a missing root has a file as an ancestor', () => {
    fsMocks.statSync.mockImplementation((path: string) => {
      if (path === '/sandbox/file/child') throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return { isDirectory: () => path === '/sandbox' };
    });
    fsMocks.watch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const watcher = ports.files.watch('/sandbox/file/child', () => {});
    expect(fsMocks.watch).toHaveBeenCalledOnce();
    expect(fsMocks.watch.mock.calls[0]?.[0]).toBe('/sandbox');
    watcher.close();
  });

  it('reports a reattach failure rather than claiming the rule source is healthy', () => {
    let emit!: (event: 'rename' | 'change', filename: string | null) => void;
    let failed = false;
    fsMocks.statSync.mockImplementation(() => {
      if (failed) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return { isDirectory: () => true };
    });
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.watch.mockImplementation((_root, _options, cb) => {
      emit = cb;
      return { on: vi.fn(), close: vi.fn() };
    });
    const events: unknown[] = [];
    const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, '/storage');
    const watcher = ports.files.watch('/sandbox/root', (event) => events.push(event));
    failed = true;
    emit('rename', null);
    expect(events).toEqual([
      { path: '/sandbox/root', change: 'modify', watchError: true, errorCode: 'EACCES', errorPath: '/sandbox/root' },
    ]);
    watcher.close();
  });
});
