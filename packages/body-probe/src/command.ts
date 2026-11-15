import { execFile, type ExecFileException } from 'node:child_process';

export interface ExecResult {
  stdout: string;
}

export interface ExecOptions {
  timeout: number;
  killSignal: string;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export type RunFn = (file: string, args?: readonly string[], signal?: AbortSignal) => Promise<string>;

const defaultExec: ExecFn = (file, args, options) => new Promise((resolve, reject) => {
  let result: { error: ExecFileException | null; stdout: string; stderr: string } | undefined;
  const child = execFile(file, [...args], {
    timeout: options.timeout,
    killSignal: options.killSignal as NodeJS.Signals,
    maxBuffer: options.maxBuffer,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  }, (error, stdout, stderr) => {
    result = { error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  });
  // On abort the execFile callback can fire before the child has actually
  // exited; settle only at 'close', when the process is gone for sure.
  child.once('close', () => {
    if (!result) return reject(new Error(`${file}: closed without an exit status`));
    if (result.error) {
      // Keep captured output on the error so callers can match diagnostics
      // like route's "not in table".
      Object.assign(result.error, { stdout: result.stdout, stderr: result.stderr });
      return reject(result.error);
    }
    resolve({ stdout: result.stdout });
  });
});

interface Pending {
  signal: AbortSignal | undefined;
  promise: Promise<string>;
}

const inflight = new Map<string, Pending>();
const active = new Set<Pending>();

function track(signal: AbortSignal | undefined, promise: Promise<string>): Promise<string> {
  const entry: Pending = { signal, promise };
  active.add(entry);
  promise.finally(() => { active.delete(entry); }).catch(() => {});
  return promise;
}

export function runCommand(
  file: string,
  args: readonly string[] = [],
  exec: ExecFn = defaultExec,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const key = JSON.stringify([file, args]);
  const pending = inflight.get(key);
  if (pending) {
    if (pending.signal === signal) return track(signal, pending.promise);
    // A different generation must not borrow an aborted old command nor run
    // the identical command concurrently: wait for it to settle, then retry
    // (which re-checks the abort state before executing anything). Our own
    // abort settles this waiter immediately, without touching the foreign
    // command.
    const waited = new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      const settled = () => {
        signal?.removeEventListener('abort', onAbort);
        // Already rejected via onAbort; a fresh runCommand early-rejection
        // passed to resolve() would be an unhandled rejection.
        if (!signal?.aborted) resolve(runCommand(file, args, exec, signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(settled, settled);
    });
    return track(signal, waited);
  }
  let promise: Promise<string>;
  try {
    promise = Promise.resolve(
      exec(file, args, {
        timeout: 1000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        ...(signal ? { signal } : {}),
      }),
    ).then((r) => r.stdout);
  } catch (err) {
    promise = Promise.reject(err);
  }
  inflight.set(key, { signal, promise });
  promise.finally(() => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  }).catch(() => {});
  return track(signal, promise);
}

// Awaits every command currently tracked under `signal` (all signals when
// omitted), looping so requests queued behind other signals are included
// once they start. Aborted waiters never execute and settle immediately.
export async function drainCommands(signal?: AbortSignal): Promise<void> {
  for (;;) {
    const pending = [...active].filter((e) => signal === undefined || e.signal === signal);
    if (pending.length === 0) return;
    await Promise.allSettled(pending.map((e) => e.promise));
  }
}

export const defaultRun: RunFn = (file, args, signal) => runCommand(file, args ?? [], defaultExec, signal);
