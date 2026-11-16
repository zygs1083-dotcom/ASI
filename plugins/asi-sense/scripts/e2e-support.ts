import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function temporaryProfile() {
  const root = await mkdtemp(join(tmpdir(), 'asi-sense-dsh-e2e-'));
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      const remains = await access(root).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        },
      );
      if (remains) throw new Error('Temporary profile still exists');
      console.log('Temporary profile removed: yes');
    },
  };
}

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

export async function stop(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (!child.pid) return;
  const group = -child.pid;
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(group, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const wait = async (timeoutMs: number) => {
    const deadline = performance.now() + timeoutMs;
    while (signal(0)) {
      if (performance.now() >= deadline) return false;
      await delay(50);
    }
    return true;
  };
  signal('SIGTERM');
  if (!(await wait(graceMs))) {
    signal('SIGKILL');
    if (!(await wait(5000))) throw new Error('DSH process group did not exit after SIGKILL');
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

export function wakeDiagnostics(log: Record<string, unknown>[]) {
  const wakes = envFollowups(log);
  const wake = wakes[0];
  const index = wake ? log.indexOf(wake) : -1;
  const tail = index < 0 ? [] : log.slice(index + 1);
  const end = tail.find((event) => event.type === 'turn/end');
  const reason = record(record(end?.data).reason);
  const turn = record(end?.data).turn;
  const assistantLength = (event: Record<string, unknown> | undefined) => {
    if (!event) return null;
    const content = record(record(event.data).message).content;
    return Array.isArray(content)
      ? content
          .map(record)
          .reduce(
            (sum, part) => sum + (part.type === 'text' && typeof part.text === 'string' ? part.text.length : 0),
            0,
          )
      : 0;
  };
  const last = [...log].reverse().find((event) => event.type === 'assistant/message');
  const reply = [...tail]
    .reverse()
    .find(
      (event) =>
        event.type === 'assistant/message' &&
        record(event.data).turn === turn &&
        record(event.data).interrupted !== true,
    );
  const status =
    wakes.length > 1
      ? '唤醒次数不符'
      : !wake
        ? '等待唤醒超时'
        : !end
          ? '唤醒已发生但回复未完成'
          : reason.kind !== 'completed' || !assistantLength(reply)
            ? '回复有错误'
            : '完成';
  const lastEnd = [...log].reverse().find((event) => event.type === 'turn/end');
  return {
    status,
    wakeCount: wakes.length,
    environmentMessages: envMessages(log).length,
    lastAssistantLength: assistantLength(last),
    lastTurnEnd: record(record(lastEnd?.data).reason).kind ?? null,
    wakeTurnEnd: reason.kind ?? null,
    wakeErrorCode: record(reason.error).code ?? null,
  };
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
