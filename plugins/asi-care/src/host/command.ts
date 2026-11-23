/**
 * Bounded, zero-shell `execFile` command runner for `asi-care`.
 *
 * - Strictly uses `node:child_process` `execFile` (never invokes a shell).
 * - Enforces hard timeouts, `maxBuffer`, `LC_ALL=C`, and `GIT_OPTIONAL_LOCKS=0`
 *   on read-only Git queries so `asi-care` never contends for or creates `.git/index.lock`.
 * - Distinguishes normal process exit codes (e.g. `lsof` exit 1 = zero open holders,
 *   `git merge-base --is-ancestor` exit 1 = non-ancestor) from infrastructure
 *   failures (`ENOENT`, timeout, signal kill, abort) for fail-closed safety.
 */

import { type ExecFileException, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface CareExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  readOnlyGit?: boolean;
  signal?: AbortSignal;
}

export interface CareExecResult {
  ok: boolean;
  /** Numeric exit code when the child exited normally; `null` on spawn error, timeout, or signal kill. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errorCode?: string;
}

export type CareExecFn = (
  bin: 'git' | 'lsof' | 'ps',
  args: readonly string[],
  options?: CareExecOptions,
) => Promise<CareExecResult>;

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function candidatePathsFor(bin: 'git' | 'lsof' | 'ps'): readonly string[] {
  if (bin === 'git') {
    return [
      join(sep, 'usr', 'bin', 'git'),
      join(sep, 'opt', 'homebrew', 'bin', 'git'),
      join(sep, 'usr', 'local', 'bin', 'git'),
      'git',
    ];
  }
  if (bin === 'lsof') {
    return [join(sep, 'usr', 'sbin', 'lsof'), join(sep, 'usr', 'bin', 'lsof'), 'lsof'];
  }
  return [join(sep, 'bin', 'ps'), join(sep, 'usr', 'bin', 'ps'), 'ps'];
}

function runSingleBinary(
  executable: string,
  args: readonly string[],
  options: CareExecOptions,
): Promise<CareExecResult & { enoent?: boolean }> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: 'aborted',
      errorCode: 'ABORT_ERR',
    });
  }

  const timeout = Math.max(250, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBuffer = Math.max(64 * 1024, options.maxBuffer ?? DEFAULT_MAX_BUFFER);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(options.readOnlyGit ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  };

  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer,
        env,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (err: ExecFileException | null, stdout, stderr) => {
        const outStr = String(stdout ?? '');
        const errStr = String(stderr ?? '');
        if (!err) {
          resolve({ ok: true, exitCode: 0, stdout: outStr, stderr: errStr });
          return;
        }
        const sysCode = typeof err.code === 'string' ? err.code : undefined;
        if (sysCode === 'ENOENT') {
          const cwdMissing = Boolean(options.cwd && !existsSync(options.cwd));
          resolve({
            ok: false,
            exitCode: null,
            stdout: outStr,
            stderr: errStr,
            errorCode: 'ENOENT',
            enoent: !cwdMissing,
          });
          return;
        }
        const timedOut = Boolean(err.killed);
        const numericExit = typeof err.code === 'number' && !timedOut && !err.signal ? err.code : null;
        resolve({
          ok: false,
          exitCode: numericExit,
          stdout: outStr,
          stderr: errStr,
          ...(timedOut ? { timedOut: true } : {}),
          ...(sysCode ? { errorCode: sysCode } : {}),
        });
      },
    );
  });
}

export const defaultCareExec: CareExecFn = async (bin, args, options = {}) => {
  const effectiveArgs =
    bin === 'git' && options.readOnlyGit && args[0] !== '--no-optional-locks' ? ['--no-optional-locks', ...args] : args;

  let lastResult: CareExecResult = {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: `${bin} not found`,
    errorCode: 'ENOENT',
  };
  for (const candidate of candidatePathsFor(bin)) {
    const res = await runSingleBinary(candidate, effectiveArgs, options);
    if (!res.enoent) {
      return res;
    }
    lastResult = res;
  }
  return lastResult;
};
