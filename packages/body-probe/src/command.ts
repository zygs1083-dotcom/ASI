import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ExecResult {
  stdout: string;
}

export interface ExecOptions {
  timeout: number;
  killSignal: string;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export type RunFn = (file: string, args?: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultExec: ExecFn = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: options.timeout,
    killSignal: options.killSignal as NodeJS.Signals,
    maxBuffer: options.maxBuffer,
    env: options.env,
  });
  return { stdout: String(stdout) };
};

const inflight = new Map<string, Promise<string>>();

export function runCommand(file: string, args: readonly string[] = [], exec: ExecFn = defaultExec): Promise<string> {
  const key = JSON.stringify([file, args]);
  const pending = inflight.get(key);
  if (pending) return pending;
  let promise: Promise<string>;
  try {
    promise = Promise.resolve(
      exec(file, args, {
        timeout: 1000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }),
    ).then((r) => r.stdout);
  } catch (err) {
    promise = Promise.reject(err);
  }
  inflight.set(key, promise);
  promise.finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  }).catch(() => {});
  return promise;
}
