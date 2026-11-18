import * as nodeFs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { HistoryStoragePort } from '../runtime/ports.ts';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const MONTHLY_FILE_RE = /^(\d{4}-\d{2})\.json$/;

export interface HistoryFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface HistoryFileSystem {
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  open(path: string, flags: string, mode?: number): Promise<HistoryFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function assertDateKey(date: string): void {
  if (!DATE_KEY_RE.test(date)) {
    throw new TypeError(`invalid history date key: ${date}`);
  }
}

function assertMonthKey(month: string): void {
  if (!MONTH_KEY_RE.test(month)) {
    throw new TypeError(`invalid history month key: ${month}`);
  }
}

export class FileHistoryStoragePort implements HistoryStoragePort {
  private readonly historyDir: string;
  private readonly eventsDir: string;
  private readonly dailyDir: string;
  private readonly monthlyDir: string;
  private readonly fs: HistoryFileSystem;
  private readonly onDirSyncError?: (error: unknown) => void;
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

  eventFileSize(date: string): Promise<number> {
    assertDateKey(date);
    return this.enqueue(async () => {
      try {
        const info = await this.fs.stat(join(this.eventsDir, `${date}.jsonl`));
        return info.size;
      } catch (error) {
        if (isNotFound(error)) return 0;
        throw error;
      }
    });
  }

  appendEvent(date: string, line: string): Promise<void> {
    assertDateKey(date);
    return this.enqueue(async () => {
      await this.ensureDirs(this.eventsDir);
      const target = join(this.eventsDir, `${date}.jsonl`);
      const handle = await this.fs.open(target, 'a', 0o600);
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
    });
  }

  readEvents(date: string): Promise<string | undefined> {
    assertDateKey(date);
    return this.readOptional(join(this.eventsDir, `${date}.jsonl`));
  }

  listEventDates(): Promise<string[]> {
    return this.listMatching(this.eventsDir, DATE_FILE_RE);
  }

  deleteEventDate(date: string): Promise<void> {
    assertDateKey(date);
    return this.unlinkOptional(join(this.eventsDir, `${date}.jsonl`));
  }

  readDaily(date: string): Promise<string | undefined> {
    assertDateKey(date);
    return this.readOptional(join(this.dailyDir, `${date}.json`));
  }

  writeDaily(date: string, json: string): Promise<void> {
    assertDateKey(date);
    return this.enqueue(() => this.writeAtomic(this.dailyDir, join(this.dailyDir, `${date}.json`), json));
  }

  listDailyDates(): Promise<string[]> {
    return this.listMatching(this.dailyDir, DAILY_FILE_RE);
  }

  deleteDailyDate(date: string): Promise<void> {
    assertDateKey(date);
    return this.unlinkOptional(join(this.dailyDir, `${date}.json`));
  }

  readMonthly(month: string): Promise<string | undefined> {
    assertMonthKey(month);
    return this.readOptional(join(this.monthlyDir, `${month}.json`));
  }

  writeMonthly(month: string, json: string): Promise<void> {
    assertMonthKey(month);
    return this.enqueue(() => this.writeAtomic(this.monthlyDir, join(this.monthlyDir, `${month}.json`), json));
  }

  listMonthlyMonths(): Promise<string[]> {
    return this.listMatching(this.monthlyDir, MONTHLY_FILE_RE);
  }

  clearAll(): Promise<void> {
    return this.enqueue(async () => {
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

  private async ensureDirs(leafDir: string): Promise<void> {
    await this.fs.mkdir(this.historyDir, { recursive: true, mode: 0o700 });
    await this.fs.mkdir(leafDir, { recursive: true, mode: 0o700 });
  }

  private readOptional(path: string): Promise<string | undefined> {
    return this.enqueue(async () => {
      try {
        return await this.fs.readFile(path, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
  }

  private unlinkOptional(path: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.fs.unlink(path);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    });
  }

  private listMatching(dir: string, pattern: RegExp): Promise<string[]> {
    return this.enqueue(async () => {
      let names: string[];
      try {
        names = await this.fs.readdir(dir);
      } catch (error) {
        if (isNotFound(error)) return [];
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

  private async writeAtomic(dir: string, targetPath: string, content: string): Promise<void> {
    await this.ensureDirs(dir);
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
