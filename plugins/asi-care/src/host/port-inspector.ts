/**
 * Local Dev Runtime Orphan Listening Port & Zombie Process Inspector + `SIGTERM` Effector.
 *
 * Open-Source MIT Adaptations & Attribution:
 * - Listening TCP port discovery, PID-to-port deduplication, and safe process
 *   identity verification adapted from `sindresorhus/fkill` and `sindresorhus/pid-port`
 *   (MIT License, Copyright (c) Sindre Sorhus).
 * - POSIX `ps` table & `etime` parsing adapted from `sindresorhus/ps-list`
 *   (MIT License, Copyright (c) Sindre Sorhus).
 *
 * Safety Boundaries:
 * - Only inspects local non-privileged TCP LISTEN ports (`>= 1024`) owned by
 *   whitelisted dev runtime executables (`node`, `vite`, `tsx`, `python`, `cargo`, `go`, etc.)
 *   whose `cwd` falls inside a discovered local worktree that is NOT `activeExempt` (`>= 2h` idle),
 *   and whose process elapsed runtime is `>= 2h`.
 * - Never touches system/database/container daemons, GUI `.app` bundles, DSH itself, or active DSH jobs.
 * - Termination is strictly Level 2 (requires user one-click approval), re-verifies PID + command +
 *   listening port + idle worktree right before sending `SIGTERM` (never `SIGKILL`).
 */

import { readlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';
import type { CareExecFn } from './command.js';
import { ACTIVE_EXEMPTION_MS, type DiscoveryReport, measureDirectoryLatestActivity } from './discovery.js';
import { isSameOrInside, makeTargetToken, tryRealpath } from './safety.js';

export const ORPHAN_PORT_IDLE_MS = 2 * 3_600_000; // > 2h

const DEV_RUNTIME_ALLOWLIST = new Set([
  'node',
  'nodejs',
  'tsx',
  'ts-node',
  'vite',
  'esbuild',
  'workerd',
  'bun',
  'deno',
  'next-server',
  'python',
  'python3',
  'uvicorn',
  'gunicorn',
  'flask',
  'django',
  'ruby',
  'puma',
  'rails',
  'cargo',
  'rustc',
  'go',
  'air',
  'java',
  'gradle',
  'kotlin',
  'php',
  'hugo',
  'ng',
]);

const INFRA_AND_SYSTEM_DENYLIST = new Set([
  'launchd',
  'systemd',
  'sshd',
  'postgres',
  'postmaster',
  'mysqld',
  'mariadbd',
  'redis-server',
  'memcached',
  'mongod',
  'docker',
  'dockerd',
  'containerd',
  'orbstack',
  'nginx',
  'caddy',
  'httpd',
  'tailscaled',
  'ollama',
  'verdaccio',
  'magpie',
  'asi-sense-helper',
  'electron',
  'code',
  'cursor',
  'windsurf',
]);

export interface PsProcessEntry {
  pid: number;
  ppid: number;
  elapsedMs: number;
  rssBytes: number;
  state: string;
  comm: string;
  rawComm: string;
  isGuiBundle: boolean;
}

export interface LsofListeningPort {
  pid: number;
  command: string;
  port: number;
  hosts: string[];
}

export interface OrphanDevPortItem {
  targetId: string;
  pid: number;
  ppid: number;
  command: string;
  port: number;
  hosts: string[];
  elapsedMs: number;
  rssBytes: number;
  worktreePath: string;
  displayWorktreePath: string;
}

export interface OrphanRuntimeReport {
  scannedAt: number;
  orphanPorts: OrphanDevPortItem[];
  zombieCount: number;
  orphanDshJobCount: number;
}

/**
 * Parse POSIX `ps` `etime` (`[[dd-]hh:]mm:ss`) into milliseconds.
 */
export function parsePsElapsedMs(raw: string): number {
  const clean = raw.trim();
  if (!clean) return 0;
  let days = 0;
  let timePart = clean;
  const dashIdx = clean.indexOf('-');
  if (dashIdx >= 0) {
    days = Number(clean.slice(0, dashIdx));
    timePart = clean.slice(dashIdx + 1);
    if (!Number.isFinite(days) || days < 0) return 0;
  }
  const parts = timePart.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    hours = parts[0] ?? 0;
    minutes = parts[1] ?? 0;
    seconds = parts[2] ?? 0;
  } else if (parts.length === 2) {
    minutes = parts[0] ?? 0;
    seconds = parts[1] ?? 0;
  } else {
    return 0;
  }
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function normalizeCommBasename(rawComm: string): { base: string; isGuiBundle: boolean } {
  const trimmed = rawComm.trim();
  const isGuiBundle = trimmed.toLowerCase().includes('.app/');
  const slashIdx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const baseRaw = (slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed).replace(/\s+\(.*$/, '').trim();
  // Strip trailing version suffixes like python3.12 -> python3
  const baseNormalized = baseRaw.replace(/^python3\.\d+$/i, 'python3').toLowerCase();
  const safe = String(sanitizeForModel(baseNormalized || 'unknown')).slice(0, 48);
  return { base: safe, isGuiBundle };
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,rss=,state=,comm=` output.
 */
export function parsePsRuntimeTable(stdout: string): {
  processes: Map<number, PsProcessEntry>;
  zombieCount: number;
} {
  const processes = new Map<number, PsProcessEntry>();
  let zombieCount = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+([0-9:-]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const etime = m[3] ?? '';
    const rssKiB = Number(m[4]);
    const state = m[5] ?? '';
    const rawComm = m[6] ?? '';
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;

    if (state.startsWith('Z') || rawComm.includes('<defunct>')) {
      zombieCount += 1;
    }

    const { base, isGuiBundle } = normalizeCommBasename(rawComm);
    processes.set(pid, {
      pid,
      ppid,
      elapsedMs: parsePsElapsedMs(etime),
      rssBytes: Number.isFinite(rssKiB) && rssKiB > 0 ? Math.round(rssKiB * 1024) : 0,
      state,
      comm: base,
      rawComm,
      isGuiBundle,
    });
  }

  return { processes, zombieCount };
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` machine-readable output (`pid-port` MIT adaptation).
 * Deduplicates dual-stack IPv4 + IPv6 binds by `(pid, port)`.
 */
export function parseLsofListenOutput(stdout: string): LsofListeningPort[] {
  const byPidPort = new Map<string, LsofListeningPort>();
  let currentPid: number | undefined;
  let currentCmd = '';

  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const val = rawLine.slice(1);
    if (tag === 'p') {
      const parsedPid = Number(val);
      currentPid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
      currentCmd = '';
    } else if (tag === 'c') {
      currentCmd = val.trim().toLowerCase();
    } else if (tag === 'n' && currentPid !== undefined) {
      const lastColon = val.lastIndexOf(':');
      if (lastColon <= 0) continue;
      const host = val.slice(0, lastColon).trim();
      const port = Number(val.slice(lastColon + 1).trim());
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) continue;
      const key = `${currentPid}:${port}`;
      const existing = byPidPort.get(key);
      if (existing) {
        if (host && !existing.hosts.includes(host)) existing.hosts.push(host);
      } else {
        byPidPort.set(key, {
          pid: currentPid,
          command: currentCmd,
          port,
          hosts: host ? [host] : ['*'],
        });
      }
    }
  }

  return [...byPidPort.values()];
}

/**
 * Decode `lsof -Fn` escaped path output (under `LC_ALL=C`, non-ASCII UTF-8 bytes
 * are emitted as `\xHH` sequences such as `\xe4\xb8\xad`).
 */
export function decodeLsofFieldPath(raw: string): string {
  if (!raw.includes('\\')) return raw;
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch ?? '', 'utf8')) bytes.push(b);
      continue;
    }
    const next = raw[i + 1];
    if (next === 'x' && i + 3 < raw.length) {
      const hex = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    if (next !== undefined) {
      i += 1;
      if (next === 'n') bytes.push(0x0a);
      else if (next === 'r') bytes.push(0x0d);
      else if (next === 't') bytes.push(0x09);
      else if (next === '\\') bytes.push(0x5c);
      else for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
      continue;
    }
    bytes.push(0x5c);
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseLsofCwdOutput(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const val = decodeLsofFieldPath(rawLine.slice(1));
    if (tag === 'p') {
      const p = Number(val);
      currentPid = Number.isSafeInteger(p) && p > 0 ? p : undefined;
    } else if (tag === 'n' && currentPid !== undefined && val.startsWith(sep)) {
      map.set(currentPid, val);
    }
  }
  return map;
}

function isLocalBindHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === '*' ||
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '[::1]' ||
    h === '::1' ||
    h === '[::]' ||
    h === '0.0.0.0'
  );
}

function isAllowedDevRuntime(comm: string, lsofCmd: string, isGuiBundle: boolean): boolean {
  if (isGuiBundle) return false;
  if (INFRA_AND_SYSTEM_DENYLIST.has(comm) || INFRA_AND_SYSTEM_DENYLIST.has(lsofCmd)) return false;
  if (DEV_RUNTIME_ALLOWLIST.has(comm)) return true;
  // lsof truncates `c` field to ~9 chars on some BSD/macOS versions (e.g. `next-serv` for `next-server`)
  for (const allowed of DEV_RUNTIME_ALLOWLIST) {
    if (lsofCmd && allowed.startsWith(lsofCmd) && lsofCmd.length >= 4) {
      return true;
    }
  }
  return false;
}

function hasProtectedAncestor(
  pid: number,
  processes: ReadonlyMap<number, PsProcessEntry>,
  protectedPids: ReadonlySet<number>,
): boolean {
  const visited = new Set<number>([pid]);
  let cursor = processes.get(pid)?.ppid ?? 0;
  for (let hop = 0; hop < 16 && cursor > 1; hop += 1) {
    if (protectedPids.has(cursor)) return true;
    if (visited.has(cursor)) break;
    visited.add(cursor);
    cursor = processes.get(cursor)?.ppid ?? 0;
  }
  return false;
}

async function resolveProcessCwds(
  pids: readonly number[],
  exec: CareExecFn,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const unresolvedOnDisk = new Set<number>();
  if (pids.length === 0) return out;

  const lsofRes = await exec('lsof', ['-w', '-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], {
    timeoutMs: 3_000,
    signal,
  });
  if (lsofRes.stdout) {
    for (const [pid, p] of parseLsofCwdOutput(lsofRes.stdout)) {
      const real = await tryRealpath(p);
      if (real) {
        out.set(pid, real);
      } else {
        out.set(pid, p);
        unresolvedOnDisk.add(pid);
      }
    }
  }

  if (process.platform === 'linux') {
    for (const pid of pids) {
      if (out.has(pid) && !unresolvedOnDisk.has(pid)) continue;
      const procCwd = await readlink(join(sep, 'proc', String(pid), 'cwd')).catch(() => undefined);
      if (procCwd) {
        const real = (await tryRealpath(procCwd)) ?? procCwd;
        out.set(pid, real);
      }
    }
  }

  return out;
}

/**
 * Fail-closed live external process occupancy check via `ps` + `lsof`.
 *
 * Detects any live non-zombie process whose `cwd`, executable path (`txt`/`comm`),
 * or open file descriptor (`0..255`) resides at or inside any of `targetPaths`
 * (e.g. a local dev server running >2h without touching source files, or an
 * external terminal shell `cwd`). Returns `'unknown'` on timeout/`ENOENT`/abort
 * so callers strictly fail-closed before deleting directories or worktrees.
 */
export async function checkDirectoryProcessHolders(options: {
  targetPaths: readonly string[];
  exec: CareExecFn;
  signal?: AbortSignal;
}): Promise<{ state: 'free' | 'held' | 'unknown'; holderPid?: number; holderDetail?: string }> {
  const { exec, signal } = options;
  if (signal?.aborted) {
    return { state: 'unknown', holderDetail: 'aborted' };
  }

  const normalizedSet = new Set<string>();
  for (const raw of options.targetPaths) {
    if (!raw?.trim()) continue;
    normalizedSet.add(raw);
    const real = await tryRealpath(raw);
    if (real) normalizedSet.add(real);
  }
  const checkRoots = [...normalizedSet];
  if (checkRoots.length === 0) {
    return { state: 'unknown', holderDetail: 'empty target path' };
  }
  const checkRootsLower = checkRoots.map((r) => r.toLowerCase());
  const realpathCache = new Map<string, string | null>();

  async function matchesTargetRoots(candidatePath: string): Promise<boolean> {
    if (checkRoots.some((root) => isSameOrInside(root, candidatePath))) {
      return true;
    }
    // On case-insensitive volumes (e.g. macOS default APFS) or symlinked binaries,
    // verify canonical realpath only when case-folded prefix matches.
    const lowerCand = candidatePath.toLowerCase();
    if (checkRootsLower.some((rootLower) => isSameOrInside(rootLower, lowerCand))) {
      let cached = realpathCache.get(candidatePath);
      if (cached === undefined) {
        cached = (await tryRealpath(candidatePath)) ?? null;
        realpathCache.set(candidatePath, cached);
      }
      if (cached && checkRoots.some((root) => isSameOrInside(root, cached))) {
        return true;
      }
    }
    return false;
  }

  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : undefined;
  const lsofArgs = uid
    ? ['-w', '-a', '-d', 'cwd', '-d', 'txt', '-d', 'mem', '-d', '0-1023', '-Fn', '-u', uid]
    : ['-w', '-d', 'cwd', '-d', 'txt', '-d', 'mem', '-d', '0-1023', '-Fn'];

  const [psRes, lsofRes] = await Promise.all([
    exec('ps', ['-axo', 'pid=,ppid=,etime=,rss=,state=,comm='], {
      timeoutMs: 4_000,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    }),
    exec('lsof', lsofArgs, {
      timeoutMs: 6_000,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    }),
  ]);

  if (signal?.aborted) {
    return { state: 'unknown', holderDetail: 'aborted' };
  }
  if (!psRes.ok || psRes.timedOut || psRes.errorCode === 'ENOENT' || psRes.errorCode === 'ABORT_ERR') {
    return { state: 'unknown', holderDetail: 'ps process table check failed' };
  }
  if (lsofRes.timedOut || lsofRes.errorCode === 'ENOENT' || lsofRes.errorCode === 'ABORT_ERR') {
    return { state: 'unknown', holderDetail: 'lsof open-holder check failed' };
  }
  if (!(lsofRes.exitCode === 0 || (lsofRes.exitCode === 1 && lsofRes.stderr.trim() === ''))) {
    return { state: 'unknown', holderDetail: 'lsof exited with unexpected status' };
  }

  const { processes } = parsePsRuntimeTable(psRes.stdout);
  const zombiePids = new Set<number>();
  for (const proc of processes.values()) {
    if (proc.state.startsWith('Z') || proc.rawComm.includes('<defunct>')) {
      zombiePids.add(proc.pid);
      continue;
    }
    const trimmedComm = proc.rawComm.trim();
    if (trimmedComm.startsWith(sep)) {
      const commBinary = trimmedComm.split(/\s+/)[0] ?? trimmedComm;
      if (await matchesTargetRoots(commBinary)) {
        return {
          state: 'held',
          holderPid: proc.pid,
          holderDetail: `${proc.comm} (PID ${proc.pid})`,
        };
      }
    }
  }

  let currentPid: number | undefined;
  for (const rawLine of lsofRes.stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    if (tag === 'p') {
      const parsed = Number(rawLine.slice(1));
      currentPid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
      continue;
    }
    if (tag === 'n' && currentPid !== undefined && !zombiePids.has(currentPid)) {
      const decoded = decodeLsofFieldPath(rawLine.slice(1));
      if (decoded.startsWith(sep) && (await matchesTargetRoots(decoded))) {
        const proc = processes.get(currentPid);
        return {
          state: 'held',
          holderPid: currentPid,
          holderDetail: proc ? `${proc.comm} (PID ${currentPid})` : `PID ${currentPid}`,
        };
      }
    }
  }

  return { state: 'free' };
}

export async function inspectOrphanRuntime(options: {
  now: number;
  discovery: DiscoveryReport;
  protectedPids?: ReadonlySet<number>;
  excludedReals?: readonly string[];
  orphanDshJobCount: number;
  minPortIdleMs?: number;
  exec: CareExecFn;
  signal?: AbortSignal;
}): Promise<OrphanRuntimeReport> {
  const { now, discovery, exec, signal } = options;
  const minPortIdleMs = options.minPortIdleMs ?? ORPHAN_PORT_IDLE_MS;
  const protectedPids = new Set<number>([process.pid, process.ppid, ...(options.protectedPids ?? [])]);

  const [psRes, listenRes] = await Promise.all([
    exec('ps', ['-axo', 'pid=,ppid=,etime=,rss=,state=,comm='], { timeoutMs: 3_000, signal }),
    exec('lsof', ['-w', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 3_500, signal }),
  ]);

  const { processes, zombieCount } = psRes.ok
    ? parsePsRuntimeTable(psRes.stdout)
    : { processes: new Map<number, PsProcessEntry>(), zombieCount: 0 };

  const listeners = listenRes.stdout ? parseLsofListenOutput(listenRes.stdout) : [];
  if (listeners.length === 0 || discovery.worktrees.length === 0) {
    return {
      scannedAt: now,
      orphanPorts: [],
      zombieCount,
      orphanDshJobCount: options.orphanDshJobCount,
    };
  }

  const candidateListeners = listeners.filter((item) => {
    if (protectedPids.has(item.pid) || item.pid <= 1) return false;
    if (!item.hosts.some(isLocalBindHost)) return false;
    const proc = processes.get(item.pid);
    if (!proc) return false;
    if (hasProtectedAncestor(item.pid, processes, protectedPids)) return false;
    if (proc.elapsedMs < minPortIdleMs) return false;
    return isAllowedDevRuntime(proc.comm, item.command, proc.isGuiBundle);
  });

  const uniqueCandidatePids = [...new Set(candidateListeners.map((c) => c.pid))];
  const cwds = await resolveProcessCwds(uniqueCandidatePids, exec, signal);

  // Match deepest containing worktree for accurate monorepo/linked-worktree attribution
  const sortedWorktrees = [...discovery.worktrees].sort((a, b) => b.path.length - a.path.length);
  const orphanPorts: OrphanDevPortItem[] = [];

  for (const item of candidateListeners) {
    const proc = processes.get(item.pid);
    const cwd = cwds.get(item.pid);
    if (!proc || !cwd) continue;
    if (options.excludedReals?.some((ex) => ex && isSameOrInside(ex, cwd))) continue;

    const ownerWt = sortedWorktrees.find((wt) => isSameOrInside(wt.path, cwd));
    if (!ownerWt || ownerWt.activeExempt) continue;

    orphanPorts.push({
      targetId: makeTargetToken('port', `${item.pid}:${proc.comm}:${item.port}:${ownerWt.path}`),
      pid: item.pid,
      ppid: proc.ppid,
      command: proc.comm,
      port: item.port,
      hosts: item.hosts,
      elapsedMs: proc.elapsedMs,
      rssBytes: proc.rssBytes,
      worktreePath: ownerWt.path,
      displayWorktreePath: ownerWt.displayPath,
    });
  }

  orphanPorts.sort((a, b) => b.rssBytes - a.rssBytes || b.elapsedMs - a.elapsedMs || a.port - b.port);

  return {
    scannedAt: now,
    orphanPorts,
    zombieCount,
    orphanDshJobCount: options.orphanDshJobCount,
  };
}

/**
 * Level 2 User-Approved Effector: re-verify process identity, port ownership,
 * and worktree non-activity right before sending `SIGTERM` (never `SIGKILL`).
 */
export async function terminateApprovedOrphanPort(options: {
  candidate: OrphanDevPortItem;
  now?: number;
  activeSessionCwds: readonly string[];
  protectedPids?: ReadonlySet<number>;
  activeExemptionMs?: number;
  exec: CareExecFn;
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  signal?: AbortSignal;
}): Promise<{ terminated: boolean; port: number; pid: number; command: string }> {
  const { candidate, exec, signal } = options;
  const killFn = options.killFn ?? ((pid: number, sig: NodeJS.Signals | 0) => process.kill(pid, sig));
  if (signal?.aborted) {
    throw new Error('Orphan port termination aborted');
  }

  if (
    candidate.pid <= 1 ||
    candidate.pid === process.pid ||
    candidate.pid === process.ppid ||
    options.protectedPids?.has(candidate.pid)
  ) {
    throw new Error(`Refusing to signal protected PID ${candidate.pid}`);
  }

  for (const sessCwd of options.activeSessionCwds) {
    if (isSameOrInside(candidate.worktreePath, sessCwd)) {
      throw new Error('Refusing to stop port: an active DSH session is now running in its worktree');
    }
  }

  // Re-verify owning worktree 2-hour active protection window when `now` or `activeExemptionMs` is supplied
  if (options.now !== undefined || options.activeExemptionMs !== undefined) {
    const checkNow = options.now ?? Date.now();
    const exemptionMs = options.activeExemptionMs ?? ACTIVE_EXEMPTION_MS;
    const wtReal = await tryRealpath(candidate.worktreePath);
    if (wtReal) {
      const latestAct = await measureDirectoryLatestActivity(wtReal, undefined, signal);
      if (signal?.aborted) {
        throw new Error('Orphan port termination aborted');
      }
      if (latestAct > 0 && checkNow - latestAct < exemptionMs) {
        throw new Error('Refusing to stop port: files in its worktree were modified within the 2-hour active window');
      }
    }
  }

  // Re-verify live process identity via `ps` (prevents PID wrap/reuse race)
  const psRes = await exec('ps', ['-p', String(candidate.pid), '-o', 'pid=,ppid=,etime=,rss=,state=,comm='], {
    timeoutMs: 2_000,
    signal,
  });
  const { processes } = psRes.ok ? parsePsRuntimeTable(psRes.stdout) : { processes: new Map<number, PsProcessEntry>() };
  const liveProc = processes.get(candidate.pid);
  if (!liveProc) {
    throw new Error(`Process ${candidate.pid} is no longer running`);
  }
  if (liveProc.comm !== candidate.command || liveProc.isGuiBundle) {
    throw new Error(
      `Refusing to signal PID ${candidate.pid}: command changed from "${candidate.command}" to "${liveProc.comm}"`,
    );
  }

  // Re-verify PID still holds the exact TCP LISTEN port and has not moved outside the worktree
  const [listenRes, liveCwds] = await Promise.all([
    exec('lsof', ['-w', '-nP', '-a', '-p', String(candidate.pid), '-iTCP', '-sTCP:LISTEN', '-Fpcn'], {
      timeoutMs: 2_500,
      signal,
    }),
    resolveProcessCwds([candidate.pid], exec, signal),
  ]);
  if (signal?.aborted) {
    throw new Error('Orphan port termination aborted');
  }
  const liveCwd = liveCwds.get(candidate.pid);
  if (liveCwd && !isSameOrInside(candidate.worktreePath, liveCwd)) {
    throw new Error(`Refusing to signal PID ${candidate.pid}: working directory moved outside target worktree`);
  }
  const livePorts = parseLsofListenOutput(listenRes.stdout);
  if (!livePorts.some((p) => p.pid === candidate.pid && p.port === candidate.port)) {
    throw new Error(`PID ${candidate.pid} is no longer listening on TCP port ${candidate.port}`);
  }

  killFn(candidate.pid, 'SIGTERM');
  return {
    terminated: true,
    port: candidate.port,
    pid: candidate.pid,
    command: candidate.command,
  };
}
