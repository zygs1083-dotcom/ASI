import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { StoragePort } from '../runtime/ports.ts';

interface StorageFile {
  writeFile(value: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: 'r' | 'wx', mode?: number): Promise<StorageFile>;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class FileStoragePort implements StoragePort {
  private tail = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly fs: StorageFileSystem,
    private readonly warn: () => void,
    private readonly backupNotice: () => void = () => {},
    readonly reportBackupFailure: (code: string) => void = () => {},
  ) {}

  private path(key: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(key)) throw new TypeError('invalid storage key');
    return join(this.root, `${key}.json`);
  }

  async load(key: string): Promise<string | undefined> {
    const path = this.path(key);
    await this.tail;
    try {
      return await this.fs.readFile(path, 'utf8');
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  save(key: string, json: string): Promise<void> {
    const write = this.tail.then(() => this.commit(key, json));
    this.tail = write.catch(() => undefined);
    return write;
  }

  backup(key: string, original: string): Promise<string> {
    const write = this.tail.then(async () => {
      const target = this.path(key);
      const bytes = await this.fs.readFile(target);
      if (Buffer.from(bytes).toString('utf8') !== original) {
        throw Object.assign(new Error('storage snapshot changed before backup'), { code: 'SNAPSHOT_CHANGED' });
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const prefix = `${basename(target)}.bak-`;
      let path = `${target}.bak-${hash}`;
      const temp = join(this.root, `.${key}.${randomUUID()}.tmp`);
      let handle: StorageFile | undefined;
      let created = false;
      let installed = false;
      let complete = false;
      try {
        let existing = false;
        let hashDamaged = false;
        const names = await this.fs.readdir(this.root);
        const nameSet = new Set(names);
        for (const name of names) {
          if (!name.startsWith(prefix)) continue;
          const suffix = name.slice(prefix.length);
          if (suffix !== hash && !/^\d{1,20}-[a-f0-9-]{36}$/i.test(suffix)) continue;
          const candidate = join(this.root, name);
          let content: Uint8Array;
          try {
            content = await this.fs.readFile(candidate);
          } catch {
            if (suffix === hash) hashDamaged = true;
            continue;
          }
          if (createHash('sha256').update(content).digest('hex') === hash && Buffer.from(content).equals(bytes)) {
            path = candidate;
            existing = true;
            break;
          }
          if (suffix === hash) hashDamaged = true;
        }
        if (!existing && hashDamaged) {
          do {
            path = `${target}.bak-${Date.now()}-${randomUUID()}`;
          } while (nameSet.has(basename(path)));
        }
        if (existing) {
          handle = await this.fs.open(path, 'r');
          await handle.sync();
          await handle.close();
          handle = undefined;
        } else {
          handle = await this.fs.open(temp, 'wx', 0o600);
          created = true;
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await this.fs.rename(temp, path);
          created = false;
          installed = true;
        }
        const directory = await this.fs.open(this.root, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        complete = true;
        await Promise.resolve()
          .then(() => this.backupNotice())
          .catch(() => undefined);
        return basename(path);
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (created) await this.fs.unlink(temp).catch(() => {});
        if (installed && !complete) await this.fs.unlink(path).catch(() => {});
      }
    });
    this.tail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async commit(key: string, json: string): Promise<void> {
    const target = this.path(key);
    const temp = join(this.root, `.${key}.${randomUUID()}.tmp`);
    let handle: StorageFile | undefined;
    let created = false;
    try {
      await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      handle = await this.fs.open(temp, 'wx', 0o600);
      created = true;
      await handle.writeFile(json);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fs.rename(temp, target);
      created = false;
    } catch (error) {
      const failures: unknown[] = [error];
      if (handle) await handle.close().catch((failure: unknown) => failures.push(failure));
      if (created) {
        await this.fs.unlink(temp).catch((failure: unknown) => {
          if (!missing(failure)) failures.push(failure);
        });
      }
      if (failures.length > 1) throw new AggregateError(failures, 'storage write and cleanup failed');
      throw error;
    }
    try {
      const directory = await this.fs.open(this.root, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      await Promise.resolve()
        .then(() => this.warn())
        .catch(() => undefined);
    }
  }
}
