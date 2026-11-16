import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStoragePort, type StorageFileSystem } from '../../src/host/dsh/storage.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(fault?: string) {
  const root = await fs.mkdtemp(join(tmpdir(), 'asi-sense-storage-'));
  roots.push(root);
  const warn = vi.fn();
  const original = new FileStoragePort(root, fs, warn);
  await original.save('settings', 'old');
  const io: StorageFileSystem = {
    ...fs,
    mkdir: async (...args) => {
      if (fault === 'mkdir') throw new Error('mkdir failed');
      return fs.mkdir(...args);
    },
    rename: async (...args) => {
      if (fault === 'rename') throw new Error('rename failed');
      return fs.rename(...args);
    },
    open: async (path, flags, mode) => {
      const directory = flags === 'r';
      if (fault === (directory ? 'dir-open' : 'file-open')) throw new Error('open failed');
      const handle = await fs.open(path, flags, mode);
      return {
        writeFile: async (value) => {
          if (fault === 'write') throw new Error('write failed');
          await handle.writeFile(value);
        },
        sync: async () => {
          if (fault === (directory ? 'dir-sync' : 'file-sync')) throw new Error('sync failed');
          await handle.sync();
        },
        close: async () => {
          await handle.close();
          if (fault === (directory ? 'dir-close' : 'file-close')) throw new Error('close failed');
        },
      };
    },
  };
  return { root, warn, port: new FileStoragePort(root, io, warn) };
}

describe('atomic file storage', () => {
  it.each(['mkdir', 'file-open', 'write', 'file-sync', 'file-close', 'rename'])(
    'rejects a %s failure without installing the replacement or retaining its temporary file',
    async (fault) => {
      const { root, port } = await fixture(fault);
      await expect(port.save('settings', 'new')).rejects.toThrow();
      expect(await fs.readFile(join(root, 'settings.json'), 'utf8')).toBe('old');
      expect(await fs.readdir(root)).toEqual(['settings.json']);
    },
  );

  it.each(['dir-open', 'dir-sync', 'dir-close'])(
    'reports a post-rename %s failure without rejecting the installed replacement',
    async (fault) => {
      const { root, port, warn } = await fixture(fault);
      await expect(port.save('settings', 'new')).resolves.toBeUndefined();
      expect(await fs.readFile(join(root, 'settings.json'), 'utf8')).toBe('new');
      expect(warn).toHaveBeenCalledOnce();
      expect(await fs.readdir(root)).toEqual(['settings.json']);
    },
  );

  it('serializes writes and reads the latest installed value', async () => {
    const { port } = await fixture();
    await Promise.all([port.save('settings', 'one'), port.save('settings', 'two'), port.save('settings', 'three')]);
    await expect(port.load('settings')).resolves.toBe('three');
    await expect(port.load('missing')).resolves.toBeUndefined();
    await expect(port.save('../other', '{}')).rejects.toThrow();
  });
});
