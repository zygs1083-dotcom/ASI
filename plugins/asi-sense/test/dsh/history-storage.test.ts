import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  it('rejects symlinks via lstat/O_NOFOLLOW, hardens permissive modes to 0700/0600, and reports dir/FIFO collisions', async () => {
    const root = await makeTempDir();
    const histDir = join(root, 'history');
    const eventsDir = join(histDir, 'events');
    const dailyDir = join(histDir, 'daily');
    const monthlyDir = join(histDir, 'monthly');
    await mkdir(eventsDir, { recursive: true, mode: 0o755 });
    await mkdir(dailyDir, { recursive: true, mode: 0o755 });
    await mkdir(monthlyDir, { recursive: true, mode: 0o755 });
    await chmod(histDir, 0o755);
    await chmod(eventsDir, 0o755);
    await chmod(dailyDir, 0o755);
    await chmod(monthlyDir, 0o755);

    const existingEv = join(eventsDir, '2026-11-18.jsonl');
    const existingDaily = join(dailyDir, '2026-11-17.json');
    const existingMonthly = join(monthlyDir, '2026-10.json');
    await writeFile(existingEv, '{"id":"e1"}\n', { mode: 0o644 });
    await writeFile(existingDaily, '{}', { mode: 0o644 });
    await writeFile(existingMonthly, '{}', { mode: 0o644 });
    await chmod(existingEv, 0o644);
    await chmod(existingDaily, 0o644);
    await chmod(existingMonthly, 0o644);

    const victim = join(root, 'outside-victim.txt');
    await writeFile(victim, 'SECRET_OUTSIDE_CONTENT\n', { mode: 0o644 });
    await chmod(victim, 0o644);
    await symlink(victim, join(eventsDir, '2026-11-19.jsonl'));
    await symlink(victim, join(dailyDir, '2026-11-19.json'));
    await symlink(victim, join(monthlyDir, '2026-11.json'));
    await mkdir(join(eventsDir, '2026-11-20.jsonl'));
    execFileSync('mkfifo', [join(eventsDir, '2026-11-21.jsonl')]);

    const port = new FileHistoryStoragePort(root);
    const unsafe = await port.harden();
    expect(unsafe).toEqual(
      expect.arrayContaining([
        { kind: 'events', name: '2026-11-19.jsonl', code: 'ELOOP' },
        { kind: 'events', name: '2026-11-20.jsonl', code: 'EISDIR' },
        { kind: 'events', name: '2026-11-21.jsonl', code: 'EINVAL' },
        { kind: 'daily', name: '2026-11-19.json', code: 'ELOOP' },
        { kind: 'monthly', name: '2026-11.json', code: 'ELOOP' },
      ]),
    );

    expect((await stat(histDir)).mode & 0o777).toBe(0o700);
    expect((await stat(eventsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(dailyDir)).mode & 0o777).toBe(0o700);
    expect((await stat(monthlyDir)).mode & 0o777).toBe(0o700);
    expect((await stat(existingEv)).mode & 0o777).toBe(0o600);
    expect((await stat(existingDaily)).mode & 0o777).toBe(0o600);
    expect((await stat(existingMonthly)).mode & 0o777).toBe(0o600);

    await expect(port.appendEvent('2026-11-19', '{"id":"leak"}\n')).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(port.readEvents('2026-11-19')).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(port.eventFileSize('2026-11-19')).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(port.readDaily('2026-11-19')).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(port.readMonthly('2026-11')).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(port.writeDaily('2026-11-19', '{}')).rejects.toMatchObject({ code: 'ELOOP' });

    await expect(port.readEvents('2026-11-20')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(port.deleteEventDate('2026-11-20')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(port.readEvents('2026-11-21')).rejects.toMatchObject({ code: 'EINVAL' });

    // Outside victim file remains intact with original content & permissions
    expect(await readFile(victim, 'utf8')).toBe('SECRET_OUTSIDE_CONTENT\n');
    expect((await stat(victim)).mode & 0o777).toBe(0o644);

    // Rejects invalid calendar dates/months and symlink history directory
    expect(() => port.readEvents('2026-02-30')).toThrow(TypeError);
    expect(() => port.readMonthly('2026-13')).toThrow(TypeError);

    const symRoot = await makeTempDir();
    const externalDir = join(symRoot, 'external');
    await mkdir(externalDir, { recursive: true });
    await symlink(externalDir, join(symRoot, 'history'));
    const symPort = new FileHistoryStoragePort(symRoot);
    await expect(symPort.appendEvent('2026-11-18', '{"id":"x"}\n')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await symPort.harden()).toEqual([{ kind: 'dir', name: 'history', code: 'ELOOP' }]);
  });

  it('streams multi-byte UTF-8 lines across 64 KiB chunks in forward and reverse order, heals unterminated trailing line, and cleans failed atomic tmp', async () => {
    const root = await makeTempDir();
    const port = new FileHistoryStoragePort(root);
    await mkdir(join(root, 'history', 'events'), { recursive: true, mode: 0o700 });

    // Seed unterminated trailing line, then append via port -> must insert '\n' before appending
    const filePath = join(root, 'history', 'events', '2026-11-18.jsonl');
    await writeFile(filePath, '{"record":"event","id":"partial"', { mode: 0o600 });
    await port.appendEvent('2026-11-18', '{"record":"lifecycle","state":"active","at":1000,"boot":true}\n');
    expect(await port.readEvents('2026-11-18')).toBe(
      '{"record":"event","id":"partial"\n{"record":"lifecycle","state":"active","at":1000,"boot":true}\n',
    );

    // > 140 KiB file with 3- and 4-byte UTF-8 chars across 64 KiB chunk boundaries + CRLF + empty lines + no final newline
    const lines: string[] = [];
    let totalBytes = 0;
    for (let i = 0; totalBytes < 140 * 1024; i++) {
      const text = JSON.stringify({
        record: 'event',
        id: `utf8-${i}`,
        subject: `应用-${i}-🚀-中文测试-${'汉'.repeat(40)}`,
      });
      lines.push(text);
      totalBytes += Buffer.byteLength(text, 'utf8') + 1;
    }
    await writeFile(join(root, 'history', 'events', '2026-11-19.jsonl'), `${lines.join('\r\n\n')}`, { mode: 0o600 });

    const fwd: string[] = [];
    for await (const line of port.readEventLines('2026-11-19')) fwd.push(line);
    expect(fwd).toEqual(lines);

    const rev: string[] = [];
    for await (const line of port.readEventLinesDesc('2026-11-19')) rev.push(line);
    expect(rev).toEqual([...lines].reverse());

    // Atomic write failure removes .tmp-* and preserves previous file
    await port.writeDaily('2026-11-18', '{"ok":1}');
    const fsPromises = await import('node:fs/promises');
    const failRenameFs: HistoryFileSystem = {
      mkdir: (p, opts) => fsPromises.mkdir(p, opts),
      readdir: (p) => fsPromises.readdir(p),
      stat: (p) => fsPromises.stat(p),
      lstat: (p) => fsPromises.lstat(p),
      chmod: (p, m) => fsPromises.chmod(p, m),
      readFile: (p, enc) => fsPromises.readFile(p, enc),
      open: (p, flags, mode) => fsPromises.open(p, flags, mode),
      rename: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      unlink: (p) => fsPromises.unlink(p),
      rm: (p, opts) => fsPromises.rm(p, opts),
    };
    const failPort = new FileHistoryStoragePort(root, failRenameFs);
    await expect(failPort.writeDaily('2026-11-18', '{"ok":2}')).rejects.toThrow('EACCES');
    expect(await port.readDaily('2026-11-18')).toBe('{"ok":1}');
    expect(await readdir(join(root, 'history', 'daily'))).toEqual(['2026-11-18.json']);

    // Concurrent writes serialize cleanly without interleaving
    await Promise.all([
      port.appendEvent('2026-11-22', '{"id":1}\n'),
      port.appendEvent('2026-11-22', '{"id":2}\n'),
      port.appendEvent('2026-11-22', '{"id":3}\n'),
    ]);
    expect(await port.readEvents('2026-11-22')).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
  });

  it('does not cache verifiedNewlineDates when appendEvent fails before write completes (#7)', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, 'history', 'events'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'history', 'events', '2026-11-18.jsonl'), '{"record":"event","id":"unterm"', {
      mode: 0o600,
    });
    const fsPromises = await import('node:fs/promises');
    let failOnce = true;
    const flakyFs: HistoryFileSystem = {
      mkdir: (p, opts) => fsPromises.mkdir(p, opts),
      readdir: (p) => fsPromises.readdir(p),
      stat: (p) => fsPromises.stat(p),
      lstat: (p) => fsPromises.lstat(p),
      chmod: (p, m) => fsPromises.chmod(p, m),
      readFile: (p, enc) => fsPromises.readFile(p, enc),
      rename: (o, n) => fsPromises.rename(o, n),
      unlink: (p) => fsPromises.unlink(p),
      rm: (p, opts) => fsPromises.rm(p, opts),
      open: async (p, flags, mode) => {
        const h = await fsPromises.open(p, flags as number, mode);
        return {
          read: h.read.bind(h),
          readFile: h.readFile.bind(h),
          stat: h.stat.bind(h),
          chmod: h.chmod.bind(h),
          sync: h.sync.bind(h),
          close: h.close.bind(h),
          writeFile: async (data: string, enc: BufferEncoding) => {
            if (failOnce) {
              failOnce = false;
              throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
            }
            return h.writeFile(data, enc);
          },
        };
      },
    };
    const flakyPort = new FileHistoryStoragePort(root, flakyFs);
    await expect(flakyPort.appendEvent('2026-11-18', '{"record":"event","id":"first"}\n')).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    await flakyPort.appendEvent('2026-11-18', '{"record":"event","id":"second"}\n');
    expect(await readFile(join(root, 'history', 'events', '2026-11-18.jsonl'), 'utf8')).toBe(
      '{"record":"event","id":"unterm"\n{"record":"event","id":"second"}\n',
    );
  });
});
