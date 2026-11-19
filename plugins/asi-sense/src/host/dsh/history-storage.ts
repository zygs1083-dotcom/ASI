import { constants as fsConstants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseDateKey, parseMonthKey } from '../runtime/history/time.ts';
import type { HistoryStoragePort, HistoryUnsafeEntry } from '../runtime/ports.ts';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const MONTHLY_FILE_RE = /^(\d{4}-\d{2})\.json$/;
const STREAM_CHUNK_BYTES = 65_536;

export interface HistoryFileStat {
  size: number;
  mode?: number;
  isFile?: () => boolean;
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
}

export interface HistoryFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  read?(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  readFile?(encoding: BufferEncoding): Promise<string>;
  stat?(): Promise<HistoryFileStat>;
  chmod?(mode: number): Promise<void>;
}

export interface HistoryFileSystem {
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<HistoryFileStat>;
  lstat?(path: string): Promise<HistoryFileStat>;
  chmod?(path: string, mode: number): Promise<void>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  open(path: string, flags: string | number, mode?: number): Promise<HistoryFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT';
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function assertDateKey(date: string): void {
  if (!DATE_KEY_RE.test(date) || !parseDateKey(date)) {
    throw new TypeError(`invalid history date key: ${date}`);
  }
}

function assertMonthKey(month: string): void {
  if (!MONTH_KEY_RE.test(month) || !parseMonthKey(month)) {
    throw new TypeError(`invalid history month key: ${month}`);
  }
}

function assertRegularFileStat(info: HistoryFileStat, pathDesc: string): void {
  if (info.isSymbolicLink?.()) {
    throw errnoError('ELOOP', `refusing symlink history file: ${pathDesc}`);
  }
  if (info.isDirectory?.()) {
    throw errnoError('EISDIR', `EISDIR: history file path is a directory: ${pathDesc}`);
  }
  if (info.isFile && !info.isFile()) {
    throw errnoError('EINVAL', `history file path is not a regular file: ${pathDesc}`);
  }
}

function trimLineBuffer(bytes: Buffer): string {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
  return bytes.subarray(0, end).toString('utf8').trim();
}

export class FileHistoryStoragePort implements HistoryStoragePort {
  private readonly historyDir: string;
  private readonly eventsDir: string;
  private readonly dailyDir: string;
  private readonly monthlyDir: string;
  private readonly fs: HistoryFileSystem;
  private readonly onDirSyncError?: (error: unknown) => void;
  private readonly verifiedNewlineDates = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(
    storageRoot: string,
    fs: HistoryFileSystem = nodeFs as unknown as HistoryFileSystem,
    onDirSyncError?: (error: unknown) => void,
  ) {
    if (!isAbsolute(storageRoot)) {
      throw new TypeError('asi-sense storageRoot must be absolute');
    }
    this.historyDir = join(storageRoot, 'history');
    this.eventsDir = join(this.historyDir, 'events');
    this.dailyDir = join(this.historyDir, 'daily');
    this.monthlyDir = join(this.historyDir, 'monthly');
    this.fs = fs;
    this.onDirSyncError = onDirSyncError;
  }

  harden(): Promise<HistoryUnsafeEntry[]> {
    return this.enqueue(async () => {
      const unsafe: HistoryUnsafeEntry[] = [];
      try {
        const rootOk = await this.ensureSafeDir(this.historyDir, false);
        if (!rootOk) return unsafe;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'EINVAL';
        unsafe.push({ kind: 'dir', name: 'history', code });
        return unsafe;
      }

      const subdirs: Array<{ kind: 'events' | 'daily' | 'monthly'; dir: string }> = [
        { kind: 'events', dir: this.eventsDir },
        { kind: 'daily', dir: this.dailyDir },
        { kind: 'monthly', dir: this.monthlyDir },
      ];
      await Promise.all(
        subdirs.map(async ({ kind, dir }) => {
          try {
            const ok = await this.checkExistingSafeDir(dir);
            if (!ok) return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'EINVAL';
            unsafe.push({ kind: 'dir', name: kind, code });
            return;
          }

          const names = await this.fs.readdir(dir);
          await Promise.all(
            names.map(async (name) => {
              const entryPath = join(dir, name);
              let info: HistoryFileStat;
              try {
                info = await this.lstatPath(entryPath);
              } catch (error) {
                if (isMissing(error)) return;
                throw error;
              }
              if (info.isSymbolicLink?.()) {
                unsafe.push({ kind, name, code: 'ELOOP' });
                return;
              }
              if (info.isDirectory?.()) {
                unsafe.push({ kind, name, code: 'EISDIR' });
                return;
              }
              if (info.isFile && !info.isFile()) {
                unsafe.push({ kind, name, code: 'EINVAL' });
                return;
              }
              if (info.mode !== undefined && (info.mode & 0o777) !== 0o600) {
                await this.hardenFileMode(entryPath, kind, name, unsafe);
              }
            }),
          );
        }),
      );
      return unsafe;
    });
  }

  eventFileSize(date: string): Promise<number> {
    assertDateKey(date);
    return this.enqueue(async () => {
      if (!(await this.ensureSafeDir(this.eventsDir, false))) return 0;
      const target = join(this.eventsDir, `${date}.jsonl`);
      try {
        const info = await this.lstatPath(target);
        assertRegularFileStat(info, `${date}.jsonl`);
        return info.size;
      } catch (error) {
        if (isMissing(error)) return 0;
        throw error;
      }
    });
  }

  appendEvent(date: string, line: string): Promise<void> {
    assertDateKey(date);
    return this.enqueue(async () => {
      await this.ensureSafeDir(this.eventsDir, true);
      const target = join(this.eventsDir, `${date}.jsonl`);
      try {
        const existing = await this.lstatPath(target);
        assertRegularFileStat(existing, `${date}.jsonl`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0);
      const handle = await this.fs.open(target, flags, 0o600);
      try {
        const st = await handle.stat?.();
        if (st) {
          assertRegularFileStat(st, `${date}.jsonl`);
          if (st.mode !== undefined && (st.mode & 0o777) !== 0o600) {
            if (typeof handle.chmod === 'function') await handle.chmod(0o600);
            else await this.fs.chmod?.(target, 0o600);
          }
        }

        let payload = line;
        if (!this.verifiedNewlineDates.has(date)) {
          if (st && st.size > 0 && typeof handle.read === 'function') {
            const lastByte = Buffer.allocUnsafe(1);
            const { bytesRead } = await handle.read(lastByte, 0, 1, st.size - 1);
            if (bytesRead === 1 && lastByte[0] !== 0x0a && !payload.startsWith('\n')) {
              payload = `\n${payload}`;
            }
          }
        }

        // Invalidate cached newline assurance before writing so a partial ENOSPC
        // or failed write forces the next append to inspect the file's last byte.
        this.verifiedNewlineDates.delete(date);
        await handle.writeFile(payload, 'utf8');
        if (payload.endsWith('\n')) {
          this.verifiedNewlineDates.add(date);
        }
      } finally {
        await handle.close().catch(() => {});
      }
    });
  }

  readEvents(date: string): Promise<string | undefined> {
    assertDateKey(date);
    return this.readOptional(this.eventsDir, join(this.eventsDir, `${date}.jsonl`), `${date}.jsonl`);
  }

  async *readEventLines(date: string): AsyncIterable<string> {
    assertDateKey(date);
    const target = join(this.eventsDir, `${date}.jsonl`);
    const opened = await this.enqueue(() => this.openSafeRead(this.eventsDir, target, `${date}.jsonl`));
    if (!opened) return;

    const { handle } = opened;
    try {
      if (typeof handle.read !== 'function') {
        const raw =
          typeof handle.readFile === 'function'
            ? await handle.readFile('utf8')
            : await this.fs.readFile(target, 'utf8');
        let start = 0;
        while (start < raw.length) {
          const nl = raw.indexOf('\n', start);
          const line = (nl < 0 ? raw.slice(start) : raw.slice(start, nl)).trim();
          if (line) yield line;
          if (nl < 0) break;
          start = nl + 1;
        }
        return;
      }

      let buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES * 2);
      let carryLen = 0;
      let pos = 0;
      for (;;) {
        if (buf.length - carryLen < STREAM_CHUNK_BYTES) {
          const next = Buffer.allocUnsafe(buf.length * 2);
          if (carryLen > 0) buf.copy(next, 0, 0, carryLen);
          buf = next;
        }
        const { bytesRead } = await handle.read(buf, carryLen, STREAM_CHUNK_BYTES, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const total = carryLen + bytesRead;
        const view = buf.subarray(0, total);
        let lineStart = 0;
        for (;;) {
          const nl = view.indexOf(0x0a, lineStart);
          if (nl < 0) break;
          if (nl > lineStart) {
            const text = trimLineBuffer(view.subarray(lineStart, nl));
            if (text) yield text;
          }
          lineStart = nl + 1;
        }
        carryLen = total - lineStart;
        if (carryLen > 0 && lineStart > 0) {
          buf.copy(buf, 0, lineStart, total);
        }
      }
      if (carryLen > 0) {
        const text = trimLineBuffer(buf.subarray(0, carryLen));
        if (text) yield text;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async *readEventLinesDesc(date: string): AsyncIterable<string> {
    assertDateKey(date);
    const target = join(this.eventsDir, `${date}.jsonl`);
    const opened = await this.enqueue(() => this.openSafeRead(this.eventsDir, target, `${date}.jsonl`));
    if (!opened) return;

    const { handle, size } = opened;
    try {
      if (typeof handle.read !== 'function') {
        const raw =
          typeof handle.readFile === 'function'
            ? await handle.readFile('utf8')
            : await this.fs.readFile(target, 'utf8');
        let end = raw.length;
        while (end > 0) {
          const nl = raw.lastIndexOf('\n', end - 1);
          const line = raw.slice(nl + 1, end).trim();
          if (line) yield line;
          if (nl < 0) break;
          end = nl;
        }
        return;
      }

      const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
      let pos = size;
      let carry: Buffer = Buffer.alloc(0);
      while (pos > 0) {
        const readLen = Math.min(STREAM_CHUNK_BYTES, pos);
        pos -= readLen;
        const { bytesRead } = await handle.read(buf, 0, readLen, pos);
        if (bytesRead <= 0) break;
        const chunk = buf.subarray(0, bytesRead);
        const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
        const firstNl = pos > 0 ? combined.indexOf(0x0a) : -1;
        if (pos > 0 && firstNl < 0) {
          carry = Buffer.from(combined);
          continue;
        }
        const stopAt = pos > 0 ? firstNl + 1 : 0;
        let end = combined.length;
        while (end > stopAt) {
          const prevNl = combined.lastIndexOf(0x0a, end - 1);
          if (prevNl < stopAt) {
            const text = trimLineBuffer(combined.subarray(stopAt, end));
            if (text) yield text;
            end = stopAt;
            break;
          }
          if (end > prevNl + 1) {
            const text = trimLineBuffer(combined.subarray(prevNl + 1, end));
            if (text) yield text;
          }
          end = prevNl;
        }
        carry = pos > 0 ? Buffer.from(combined.subarray(0, firstNl)) : Buffer.alloc(0);
      }
      if (carry.length > 0) {
        const text = trimLineBuffer(carry);
        if (text) yield text;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  listEventDates(): Promise<string[]> {
    return this.listMatching(this.eventsDir, DATE_FILE_RE);
  }

  deleteEventDate(date: string): Promise<void> {
    assertDateKey(date);
    this.verifiedNewlineDates.delete(date);
    return this.unlinkOptional(this.eventsDir, join(this.eventsDir, `${date}.jsonl`), `${date}.jsonl`);
  }

  readDaily(date: string): Promise<string | undefined> {
    assertDateKey(date);
    return this.readOptional(this.dailyDir, join(this.dailyDir, `${date}.json`), `${date}.json`);
  }

  writeDaily(date: string, json: string): Promise<void> {
    assertDateKey(date);
    return this.enqueue(() =>
      this.writeAtomic(this.dailyDir, join(this.dailyDir, `${date}.json`), json, `${date}.json`),
    );
  }

  listDailyDates(): Promise<string[]> {
    return this.listMatching(this.dailyDir, DAILY_FILE_RE);
  }

  deleteDailyDate(date: string): Promise<void> {
    assertDateKey(date);
    return this.unlinkOptional(this.dailyDir, join(this.dailyDir, `${date}.json`), `${date}.json`);
  }

  readMonthly(month: string): Promise<string | undefined> {
    assertMonthKey(month);
    return this.readOptional(this.monthlyDir, join(this.monthlyDir, `${month}.json`), `${month}.json`);
  }

  writeMonthly(month: string, json: string): Promise<void> {
    assertMonthKey(month);
    return this.enqueue(() =>
      this.writeAtomic(this.monthlyDir, join(this.monthlyDir, `${month}.json`), json, `${month}.json`),
    );
  }

  listMonthlyMonths(): Promise<string[]> {
    return this.listMatching(this.monthlyDir, MONTHLY_FILE_RE);
  }

  clearAll(): Promise<void> {
    return this.enqueue(async () => {
      this.verifiedNewlineDates.clear();
      await Promise.all([
        this.fs.rm(this.eventsDir, { recursive: true, force: true }),
        this.fs.rm(this.dailyDir, { recursive: true, force: true }),
        this.fs.rm(this.monthlyDir, { recursive: true, force: true }),
      ]);
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async hardenFileMode(
    entryPath: string,
    kind: 'events' | 'daily' | 'monthly',
    name: string,
    unsafe: HistoryUnsafeEntry[],
  ): Promise<void> {
    const flags = (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    let handle: HistoryFileHandle | undefined;
    try {
      handle = await this.fs.open(entryPath, flags);
    } catch (error) {
      if (isMissing(error)) return;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ELOOP' || code === 'EISDIR' || code === 'EINVAL' || code === 'ENOTDIR') {
        unsafe.push({ kind, name, code });
        return;
      }
      if (code === 'EACCES') {
        await this.fs.chmod?.(entryPath, 0o600);
        return;
      }
      throw error;
    }
    try {
      const st = await handle.stat?.();
      if (st?.isSymbolicLink?.()) {
        unsafe.push({ kind, name, code: 'ELOOP' });
        return;
      }
      if (st?.isDirectory?.()) {
        unsafe.push({ kind, name, code: 'EISDIR' });
        return;
      }
      if (st?.isFile && !st.isFile()) {
        unsafe.push({ kind, name, code: 'EINVAL' });
        return;
      }
      if (typeof handle.chmod === 'function') {
        await handle.chmod(0o600);
      } else {
        await this.fs.chmod?.(entryPath, 0o600);
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private lstatPath(targetPath: string): Promise<HistoryFileStat> {
    return this.fs.lstat ? this.fs.lstat(targetPath) : this.fs.stat(targetPath);
  }

  private async checkExistingSafeDir(dir: string): Promise<boolean> {
    let info: HistoryFileStat;
    try {
      info = await this.lstatPath(dir);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (info.isSymbolicLink?.()) {
      throw errnoError('ELOOP', `refusing symlink history directory: ${dir}`);
    }
    if (info.isDirectory && !info.isDirectory()) {
      throw errnoError('ENOTDIR', `history path is not a directory: ${dir}`);
    }
    if (info.mode !== undefined && (info.mode & 0o777) !== 0o700) {
      await this.fs.chmod?.(dir, 0o700);
    }
    return true;
  }

  private async ensureSafeDir(leafDir: string, createIfMissing: boolean): Promise<boolean> {
    if (!createIfMissing) {
      if (leafDir === this.historyDir) {
        return this.checkExistingSafeDir(this.historyDir);
      }
      const [rootOk, leafOk] = await Promise.all([
        this.checkExistingSafeDir(this.historyDir),
        this.checkExistingSafeDir(leafDir),
      ]);
      return rootOk && leafOk;
    }
    const dirs = leafDir === this.historyDir ? [this.historyDir] : [this.historyDir, leafDir];
    for (const dir of dirs) {
      let info: HistoryFileStat;
      try {
        info = await this.lstatPath(dir);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
        info = await this.lstatPath(dir);
      }
      if (info.isSymbolicLink?.()) {
        throw errnoError('ELOOP', `refusing symlink history directory: ${dir}`);
      }
      if (info.isDirectory && !info.isDirectory()) {
        throw errnoError('ENOTDIR', `history path is not a directory: ${dir}`);
      }
      if (info.mode !== undefined && (info.mode & 0o777) !== 0o700) {
        await this.fs.chmod?.(dir, 0o700);
      }
    }
    return true;
  }

  private async openSafeRead(
    dir: string,
    targetPath: string,
    label: string,
  ): Promise<{ handle: HistoryFileHandle; size: number } | undefined> {
    if (!(await this.ensureSafeDir(dir, false))) return undefined;
    let info: HistoryFileStat;
    try {
      info = await this.lstatPath(targetPath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    assertRegularFileStat(info, label);

    const flags = (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    const handle = await this.fs.open(targetPath, flags);
    try {
      const st = await handle.stat?.();
      if (st) assertRegularFileStat(st, label);
      return { handle, size: st?.size ?? info.size };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  private readOptional(dir: string, targetPath: string, label: string): Promise<string | undefined> {
    return this.enqueue(async () => {
      const opened = await this.openSafeRead(dir, targetPath, label);
      if (!opened) return undefined;
      try {
        if (typeof opened.handle.readFile === 'function') {
          return await opened.handle.readFile('utf8');
        }
        return await this.fs.readFile(targetPath, 'utf8');
      } finally {
        await opened.handle.close().catch(() => {});
      }
    });
  }

  private unlinkOptional(dir: string, targetPath: string, label: string): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.ensureSafeDir(dir, false))) return;
      try {
        const info = await this.lstatPath(targetPath);
        if (info.isDirectory?.()) {
          throw errnoError('EISDIR', `refusing to unlink directory: ${label}`);
        }
        await this.fs.unlink(targetPath);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    });
  }

  private listMatching(dir: string, pattern: RegExp): Promise<string[]> {
    return this.enqueue(async () => {
      if (!(await this.ensureSafeDir(dir, false))) return [];
      let names: string[];
      try {
        names = await this.fs.readdir(dir);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const matched: string[] = [];
      for (const name of names) {
        const hit = pattern.exec(name);
        if (hit?.[1]) matched.push(hit[1]);
      }
      matched.sort();
      return matched;
    });
  }

  private async writeAtomic(dir: string, targetPath: string, content: string, label: string): Promise<void> {
    await this.ensureSafeDir(dir, true);
    try {
      const existing = await this.lstatPath(targetPath);
      assertRegularFileStat(existing, label);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const tmpPath = join(dir, `.tmp-${process.pid}-${++this.seq}-${Date.now()}`);
    let handle: HistoryFileHandle | undefined;
    try {
      handle = await this.fs.open(tmpPath, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fs.rename(tmpPath, targetPath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
    try {
      const dirHandle = await this.fs.open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch (error) {
      this.onDirSyncError?.(error);
    }
  }
}
