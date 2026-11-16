import path from 'node:path';
import type { Signal, SignalCause } from '@asi/sense-types';

/**
 * A window in which the agent was executing a tool call. Signals inside it
 * that relate to the tool (same pid, or a path under `cwd`) are self-caused.
 */
export interface ToolWindow {
  startedAt: number;
  endedAt?: number;
  startedMono?: number;
  endedMono?: number;
  cwd?: string;
  pid?: number;
}

const CAUSAL_KINDS: ReadonlySet<string> = new Set([
  'file.changed',
  'job.started',
  'job.exited',
  'process.started',
  'process.exited',
]);

function signalPath(signal: Signal): string | undefined {
  if (typeof signal.data.path === 'string' && signal.data.path.length > 0) return signal.data.path;
  if (signal.kind === 'file.changed' && signal.subject.length > 0) return signal.subject;
  return undefined;
}

function underDir(cwd: string, p: string): boolean {
  // Both paths must be absolute: a relative signal path is never resolved
  // against the process cwd (that is not part of the source contract).
  if (!path.isAbsolute(cwd) || !path.isAbsolute(p)) return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * `ToolWindow.pid` is the shell pid: a signal is related when its own pid,
 * its parent pid or any pid in its `ancestors` chain equals it — so shell
 * children and grandchildren are covered, not just the shell itself.
 */
function relatedToShell(signal: Signal, shellPid: number): boolean {
  const d = signal.data;
  if (d.pid === shellPid || d.ppid === shellPid) return true;
  return Array.isArray(d.ancestors) && d.ancestors.includes(shellPid);
}

/**
 * Self-cause classification (DESIGN §2.3 step 2). Only file/job/process
 * signals can be agent-caused; they match a tool window when receipt is
 * within its monotonic bounds and either the signal
 * is related to the window's shell pid (pid/ppid/ancestors) or its path
 * (`data.path`, else subject for `file.changed`) lies under `window.cwd`
 * (path-boundary safe: `/repo` does not match `/repository`). Concurrent or
 * nested windows are handled by checking every window. An explicit
 * `cause: 'agent'` is always preserved; `user`/`unknown` are upgraded to
 * `agent` on match, never downgraded. File paths under cwd also match within
 * optional trailing grace by monotonic receipt.
 */
export function classifyCause(
  signal: Signal,
  toolWindows: readonly ToolWindow[] = [],
  graceMs = 0,
  receivedMono?: number,
): SignalCause {
  if (signal.cause === 'agent') return 'agent';
  const base = signal.cause ?? 'unknown';
  if (!CAUSAL_KINDS.has(signal.kind)) return base;
  for (const w of toolWindows) {
    const p = signalPath(signal);
    if (receivedMono === undefined || w.startedMono === undefined || receivedMono < w.startedMono) continue;
    if (
      w.endedMono !== undefined &&
      (signal.kind === 'file.changed' ? receivedMono >= w.endedMono + graceMs : receivedMono > w.endedMono)
    )
      continue;
    if (signal.kind === 'file.changed') {
      if (w.cwd !== undefined && p !== undefined && underDir(w.cwd, p)) return 'agent';
      continue;
    }
    if (w.pid !== undefined && relatedToShell(signal, w.pid)) return 'agent';
    if (w.cwd !== undefined && p !== undefined && underDir(w.cwd, p)) return 'agent';
  }
  return base;
}
