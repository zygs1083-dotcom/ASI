/**
 * Lightweight Read-Only Top CPU & Memory Process Sampler.
 *
 * Open-Source MIT Adaptation & Attribution:
 * - POSIX `ps` column output parsing & normalization adapted from
 *   `sindresorhus/ps-list` (MIT License, Copyright (c) Sindre Sorhus) and
 *   `soyuka/pidusage` (MIT License, Copyright (c) Antoine Bluchet).
 * - Strictly read-only: extracts executable basename only (never raw CLI
 *   arguments/env tokens), sanitizes via `sanitizeForModel`, and never sends
 *   signals to external OS processes.
 */

import { execFile } from 'node:child_process';
import { join, sep } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';

const PS_TIMEOUT_MS = 2_500;
const PS_MAX_BUFFER = 2 * 1024 * 1024;
const PS_ARGS = ['-axo', 'pid=,ppid=,rss=,%cpu=,%mem=,comm='] as const;

export type ProcessExecFn = (signal?: AbortSignal) => Promise<string>;

export interface ProcessBrief {
  pid: number;
  ppid: number;
  name: string;
  cpuPercent: number;
  rssBytes: number;
  memPercent: number;
}

export interface TopProcessesReport {
  sampledAt: number;
  totalProcesses: number;
  byCpu: ProcessBrief[];
  byMemory: ProcessBrief[];
  note: string;
  error?: string;
}

function execPsCommand(bin: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...PS_ARGS],
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER,
        env: { ...process.env, LC_ALL: 'C' },
        ...(signal ? { signal } : {}),
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

export const defaultProcessExec: ProcessExecFn = async (signal) => {
  const posixPs = join(sep, 'bin', 'ps');
  try {
    return await execPsCommand(posixPs, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return await execPsCommand('ps', signal);
    }
    throw err;
  }
};

function truncateCodePoints(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : value;
}

function normalizeProcessName(rawComm: string): string {
  const trimmed = rawComm.trim();
  if (!trimmed) return 'unknown';
  let withoutTrailing = trimmed;
  while (withoutTrailing.endsWith('/') || withoutTrailing.endsWith('\\')) {
    withoutTrailing = withoutTrailing.slice(0, -1);
  }
  withoutTrailing = withoutTrailing.trim();
  if (!withoutTrailing) return 'unknown';

  // On macOS `comm=` may include bundle path `/Applications/Foo.app/Contents/MacOS/Foo`;
  // extract only the executable basename when formatted as a filesystem path, while keeping
  // non-path Linux kernel worker names (`kworker/...`) intact and never leaking trailing-slash dirs.
  const slashCount = [...withoutTrailing].filter((ch) => ch === '/').length;
  const isPathLike =
    withoutTrailing.startsWith('/') ||
    withoutTrailing.startsWith('~') ||
    withoutTrailing.startsWith('.') ||
    withoutTrailing.includes('\\') ||
    withoutTrailing.toLowerCase().includes('.app') ||
    slashCount >= 2;
  const slashIdx = isPathLike ? Math.max(withoutTrailing.lastIndexOf('/'), withoutTrailing.lastIndexOf('\\')) : -1;
  const base = slashIdx >= 0 ? withoutTrailing.slice(slashIdx + 1).trim() : withoutTrailing;
  if (!base) return 'unknown';
  const cleaned = String(sanitizeForModel(base)).trim();
  if (!cleaned) return 'unknown';
  return truncateCodePoints(cleaned, 64);
}

export function parsePsTable(stdout: string): ProcessBrief[] {
  const rows: ProcessBrief[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKiB = Number(match[3]);
    const cpuPercent = Number(match[4]);
    const memPercent = Number(match[5]);
    const comm = match[6] ?? '';
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      !Number.isFinite(rssKiB) ||
      rssKiB < 0 ||
      !Number.isFinite(cpuPercent) ||
      cpuPercent < 0 ||
      !Number.isFinite(memPercent) ||
      memPercent < 0
    ) {
      continue;
    }
    rows.push({
      pid,
      ppid,
      name: normalizeProcessName(comm),
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      rssBytes: Math.round(rssKiB * 1024),
      memPercent: Math.round(memPercent * 10) / 10,
    });
  }
  return rows;
}

export async function sampleTopProcesses(options: {
  now: number;
  limit?: number;
  exec?: ProcessExecFn;
  signal?: AbortSignal;
}): Promise<TopProcessesReport> {
  const limit = Math.max(1, Math.min(15, options.limit ?? 5));
  const note = '外部系统进程仅供只读负载归因参考，ASI 绝不强杀或发信号干预外部应用。';
  const execFn = options.exec ?? defaultProcessExec;

  try {
    const stdout = await execFn(options.signal);
    const parsed = parsePsTable(stdout);
    const byCpu = [...parsed].sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes).slice(0, limit);
    const byMemory = [...parsed].sort((a, b) => b.rssBytes - a.rssBytes || b.cpuPercent - a.cpuPercent).slice(0, limit);

    return {
      sampledAt: options.now,
      totalProcesses: parsed.length,
      byCpu,
      byMemory,
      note,
    };
  } catch (err) {
    const rawErr = err instanceof Error ? err.message : 'process table unavailable';
    return {
      sampledAt: options.now,
      totalProcesses: 0,
      byCpu: [],
      byMemory: [],
      note,
      error: [...String(sanitizeForModel(rawErr))].slice(0, 120).join(''),
    };
  }
}
