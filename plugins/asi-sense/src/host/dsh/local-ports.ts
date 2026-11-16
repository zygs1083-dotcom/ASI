import { spawn } from 'node:child_process';
import { existsSync, lstatSync, statSync, watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BodyProbe } from '@asi/body-probe';
import type { Context } from '@deepseek-ai/cordis';
import type { SensePorts } from '../runtime/ports.ts';
import { FileStoragePort } from './storage.ts';

export function localPorts(ctx: Context, storageRoot: string): Omit<SensePorts, 'dsh'> {
  if (!isAbsolute(storageRoot)) throw new TypeError('asi-sense storageRoot must be absolute');
  return {
    clock: { wall: Date.now, mono: () => performance.now() },
    storage: new FileStoragePort(
      storageRoot,
      fs,
      () => ctx.logger.warn('asi-sense storage directory sync failed'),
      () => ctx.logger.warn('asi-sense unrecognized or invalid body snapshot backed up; AI tuning disabled'),
      (code) => ctx.logger.warn(`asi-sense body snapshot recovery failed: ${code}`),
    ),
    helper: { spawn: (path) => spawn(path, [], { stdio: 'pipe' }) },
    probe: { create: () => new BodyProbe() },
    files: {
      watch(root, callback) {
        const target = resolve(root);
        const startedAt = Date.now();
        let watcher: ReturnType<typeof watch>;
        let closed = false;
        const fail = () => {
          ctx.logger.warn('asi-sense file watcher failed');
          const event = { path: target, change: 'modify' as const, watchError: true };
          callback(event);
        };
        const inside = (parent: string, child: string) => {
          const rel = relative(parent, child);
          return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
        };
        const attach = () => {
          let candidate = target;
          for (;;) {
            try {
              const directory = statSync(candidate).isDirectory();
              if (!directory) {
                candidate = dirname(candidate);
                continue;
              }
              const base = candidate;
              const next = watch(
                base,
                { recursive: base === target || base !== dirname(target) },
                (event, filename) => {
                  if (closed || watcher !== next) return;
                  const path = !directory || filename === null ? base : resolve(base, filename.toString());
                  if (!inside(base, path)) return;
                  try {
                    if (
                      !existsSync(base) ||
                      (base !== target &&
                        existsSync(target) &&
                        (dirname(target) !== base || statSync(target).isDirectory()))
                    ) {
                      attach();
                    }
                  } catch {
                    fail();
                  }
                  if (!inside(target, path) || filename === null) return;
                  let at = Date.now();
                  const change = event === 'change' ? 'modify' : existsSync(path) ? 'add' : 'delete';
                  if (change !== 'delete') {
                    try {
                      const mtime = lstatSync(path).mtimeMs;
                      if (Number.isFinite(mtime) && mtime >= startedAt) at = mtime;
                    } catch {}
                  }
                  callback({ path, change, at });
                },
              );
              next.on('error', () => {
                if (closed || watcher !== next) return;
                fail();
              });
              const previous = watcher;
              watcher = next;
              previous?.close();
              return;
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              const parent = dirname(candidate);
              if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === candidate) throw error;
              candidate = parent;
            }
          }
        };
        attach();
        return {
          close: () => {
            closed = true;
            watcher.close();
          },
        };
      },
    },
  };
}
