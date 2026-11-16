import { type ChildProcess, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(executable, args, { cwd, env, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`DSH setup exited with code ${code}`);
}

export async function webUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('DSH did not report a local web URL')), 45_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else if (url) resolve(url);
    };
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
      if (url) finish(undefined, url);
    };
    const onExit = () => finish(new Error('DSH exited before the web server was ready'));
    const onError = (error: Error) => finish(error);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    done.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), 10_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut && child.pid) {
    process.kill(-child.pid, 'SIGKILL');
    await done;
    throw new Error('DSH did not shut down gracefully');
  }
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function events(root: string): Promise<Record<string, unknown>[]> {
  const files: string[] = [];
  async function scan(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name.endsWith('.jsonl')) files.push(path);
    }
  }
  await scan(root);
  const result: Record<string, unknown>[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const completeLines = text.split('\n').slice(0, -1);
    for (const line of completeLines.filter(Boolean)) {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) result.push(value as Record<string, unknown>);
    }
  }
  return result;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function envMessages(log: Record<string, unknown>[]): Record<string, unknown>[] {
  return log.filter(
    (event) => event.type === 'user/message' && record(record(event.data).source).kind === 'environment',
  );
}

function envInbox(log: Record<string, unknown>[], target: string): Record<string, unknown>[] {
  return log.filter((event) => {
    const data = record(event.data);
    return (
      event.type === 'agent/inbox/spliced' &&
      data.target === target &&
      Array.isArray(data.inserted) &&
      data.inserted.some((message) => record(record(message).source).kind === 'environment')
    );
  });
}

export function envFollowups(log: Record<string, unknown>[]): Record<string, unknown>[] {
  return envInbox(log, 'next-turn');
}

export function envInjections(log: Record<string, unknown>[]): Record<string, unknown>[] {
  return envInbox(log, 'next-step');
}

export function emptyResponse(log: Record<string, unknown>[]): string | undefined {
  for (const event of log) {
    const error = record(record(record(event.data).reason).error);
    if (event.type === 'turn/end' && error.code === 'EMPTY_RESPONSE' && typeof error.message === 'string')
      return error.message;
  }
  return undefined;
}

export function bashCommands(log: Record<string, unknown>[]): string[] {
  return log.flatMap((event) => {
    const data = record(event.data);
    if (event.type !== 'tool/call' || data.name !== 'bash' || typeof data.arguments !== 'string') return [];
    try {
      const command = record(JSON.parse(data.arguments)).command;
      return typeof command === 'string' ? [command] : [];
    } catch {
      return [];
    }
  });
}
