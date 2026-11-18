import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryStoragePort, type HistoryFileSystem } from '../../src/host/dsh/history-storage.ts';
import { localPorts } from '../../src/host/dsh/local-ports.ts';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asi-hist-storage-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileHistoryStoragePort', () => {
  it('stores events at 0o600 inside 0o700 directories and supports daily/monthly roundtrips', async () => {
    const root = await makeTempDir();
    const port = new FileHistoryStoragePort(root);

    await port.appendEvent('2026-10-15', '{"record":"event","id":"e1"}\n');
    await port.appendEvent('2026-10-15', '{"record":"event","id":"e2"}\n');
    await port.writeDaily('2026-10-14', '{"version":1,"date":"2026-10-14"}');
    await port.writeMonthly('2026-09', '{"version":1,"month":"2026-09"}');

    const histMode = (await stat(join(root, 'history'))).mode & 0o777;
    const eventsDirMode = (await stat(join(root, 'history', 'events'))).mode & 0o777;
    const dailyDirMode = (await stat(join(root, 'history', 'daily'))).mode & 0o777;
    const monthlyDirMode = (await stat(join(root, 'history', 'monthly'))).mode & 0o777;
    const eventFileMode = (await stat(join(root, 'history', 'events', '2026-10-15.jsonl'))).mode & 0o777;
    const dailyFileMode = (await stat(join(root, 'history', 'daily', '2026-10-14.json'))).mode & 0o777;
    const monthlyFileMode = (await stat(join(root, 'history', 'monthly', '2026-09.json'))).mode & 0o777;

    expect(histMode).toBe(0o700);
    expect(eventsDirMode).toBe(0o700);
    expect(dailyDirMode).toBe(0o700);
    expect(monthlyDirMode).toBe(0o700);
    expect(eventFileMode).toBe(0o600);
    expect(dailyFileMode).toBe(0o600);
    expect(monthlyFileMode).toBe(0o600);

    expect(await port.readEvents('2026-10-15')).toBe('{"record":"event","id":"e1"}\n{"record":"event","id":"e2"}\n');
    expect(await port.eventFileSize('2026-10-15')).toBe(
      Buffer.byteLength('{"record":"event","id":"e1"}\n{"record":"event","id":"e2"}\n', 'utf8'),
    );
    expect(await port.readDaily('2026-10-14')).toBe('{"version":1,"date":"2026-10-14"}');
    expect(await port.readMonthly('2026-09')).toBe('{"version":1,"month":"2026-09"}');

    // Ignores stray tmp or invalid files when listing dates/months
    await writeFile(join(root, 'history', 'events', '.tmp-stale'), 'junk');
    await writeFile(join(root, 'history', 'daily', 'notes.txt'), 'junk');
    expect(await port.listEventDates()).toEqual(['2026-10-15']);
    expect(await port.listDailyDates()).toEqual(['2026-10-14']);
    expect(await port.listMonthlyMonths()).toEqual(['2026-09']);

    await port.deleteEventDate('2026-10-15');
    await port.deleteDailyDate('2026-10-14');
    expect(await port.readEvents('2026-10-15')).toBeUndefined();
    expect(await port.eventFileSize('2026-10-15')).toBe(0);
    expect(await port.listDailyDates()).toEqual([]);

    await port.clearAll();
    expect(await port.listMonthlyMonths()).toEqual([]);
    expect(await readdir(join(root, 'history'))).toEqual([]);
  });

  it('rejects relative storageRoot and malformed date/month keys', async () => {
    expect(() => new FileHistoryStoragePort('relative/path')).toThrow(TypeError);
    const root = await makeTempDir();
    const port = new FileHistoryStoragePort(root);
    expect(() => port.readEvents('../2026-10-15')).toThrow(TypeError);
    expect(() => port.writeDaily('20261015', '{}')).toThrow(TypeError);
    expect(() => port.writeMonthly('2026-10-01', '{}')).toThrow(TypeError);
  });

  it('warns without failing atomic writes if dir sync throws, and wires through localPorts', async () => {
    const root = await makeTempDir();
    const fsPromises = await import('node:fs/promises');
    const warn = vi.fn();
    const fakeFs: HistoryFileSystem = {
      mkdir: (p, opts) => fsPromises.mkdir(p, opts),
      readdir: (p) => fsPromises.readdir(p),
      stat: (p) => fsPromises.stat(p),
      readFile: (p, enc) => fsPromises.readFile(p, enc),
      rename: (o, n) => fsPromises.rename(o, n),
      unlink: (p) => fsPromises.unlink(p),
      rm: (p, opts) => fsPromises.rm(p, opts),
      open: async (p, flags, mode) => {
        if (flags === 'r') {
          return {
            writeFile: async () => {},
            sync: async () => {
              throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
            },
            close: async () => {},
          };
        }
        return fsPromises.open(p, flags, mode);
      },
    };
    const port = new FileHistoryStoragePort(root, fakeFs, warn);
    await port.writeDaily('2026-10-18', '{"version":1,"date":"2026-10-18"}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await port.readDaily('2026-10-18')).toBe('{"version":1,"date":"2026-10-18"}');

    const local = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, root);
    expect(local.history).toBeDefined();
    expect(await local.history?.listEventDates()).toEqual([]);
    await local.history?.appendEvent('2026-10-18', '{"id":"x"}\n');
    expect(await local.history?.listEventDates()).toEqual(['2026-10-18']);
    await rm(root, { recursive: true, force: true });
    // Read after removal returns empty gracefully.
    expect(await local.history?.readEvents('2026-10-18')).toBeUndefined();
    expect(await readFile(join(root, 'history', 'daily', '2026-10-18.json')).catch(() => 'gone')).toBe('gone');
  });
});
