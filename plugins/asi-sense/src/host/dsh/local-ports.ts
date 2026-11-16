import { spawn } from 'node:child_process';
import { existsSync, lstatSync, watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BodyProbe } from '@asi/body-probe';
import type { Context } from '@deepseek-ai/cordis';
import type { SensePorts } from '../runtime/ports.ts';
import { FileStoragePort } from './storage.ts';

export function localPorts(ctx: Context, storageRoot: string): Omit<SensePorts, 'dsh'> {
  if (!isAbsolute(storageRoot)) throw new TypeError('asi-sense storageRoot must be absolute');
  return {
    clock: { wall: Date.now, mono: () => performance.now() },
    storage: new FileStoragePort(storageRoot, fs, () => ctx.logger.warn('asi-sense storage directory sync failed')),
    helper: { spawn: (path) => spawn(path, [], { stdio: 'pipe' }) },
    probe: { create: () => new BodyProbe() },
    files: {
      watch(root, callback) {
        const base = resolve(root);
        const startedAt = Date.now();
        const watcher = watch(base, { recursive: true }, (event, filename) => {
          if (filename === null) return;
          let at = Date.now();
          const path = resolve(base, filename.toString());
          const rel = relative(base, path);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
          const change = event === 'change' ? 'modify' : existsSync(path) ? 'add' : 'delete';
          if (change !== 'delete') {
            try {
              const mtime = lstatSync(path).mtimeMs;
              if (Number.isFinite(mtime) && mtime >= startedAt) at = mtime;
            } catch {}
          }
          callback({ path, change, at });
        });
        watcher.on('error', () => ctx.logger.warn('asi-sense file watcher failed'));
        return { close: () => watcher.close() };
      },
    },
  };
}
