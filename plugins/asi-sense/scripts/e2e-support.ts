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

export function wakeDiagnostics(log: Record<string, unknown>[], initialTurn: number | undefined) {
  const initialEnd = log.findIndex(
    (event) => event.type === 'turn/end' && record(event.data).turn === initialTurn && initialTurn !== undefined,
  );
  const tail = initialEnd < 0 ? [] : log.slice(initialEnd + 1);
  const starts = tail.filter((event) => event.type === 'turn/start');
  const start = starts[0];
  const settled = tail.findIndex((event) => {
    const data = record(event.data);
    return (
      event.type === 'job/settled' &&
      data.kind === 'bash' &&
      typeof data.label === 'string' &&
      data.label.includes('sleep 20') &&
      data.label.includes('exit 1') &&
      data.status === 'completed' &&
      typeof data.detail === 'string' &&
      /^exit code: 1(?:;|$)/.test(data.detail)
    );
  });
  const turn = record(start?.data).turn;
  const turnEvents = start ? tail.slice(tail.indexOf(start)) : [];
  const end = turnEvents.find((event) => event.type === 'turn/end' && record(event.data).turn === turn);
  const withinTurn = end ? turnEvents.slice(0, turnEvents.indexOf(end) + 1) : turnEvents;
  const reason = record(record(end?.data).reason);
  const reply = [...withinTurn]
    .reverse()
    .find(
      (event) =>
        event.type === 'assistant/message' &&
        record(event.data).turn === turn &&
        record(event.data).interrupted !== true,
    );
  const content = record(record(reply?.data).message).content;
  const text = Array.isArray(content)
    ? content.map(record).flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    : [];
  const environmentMessages = envMessages(tail).length;
  const turnMessages = envMessages(withinTurn).length;
  const sourceKind = (value: unknown) =>
    ['user', 'environment', 'tool-jobs', 'runtime-context'].includes(String(value)) ? String(value) : 'other';
  const sequence = tail.map((event) => {
    const data = record(event.data);
    if (event.type === 'user/message') return `user/message(${sourceKind(record(data.source).kind)})`;
    if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted) && data.inserted.length) {
      const target = data.target === 'next-turn' || data.target === 'next-step' ? data.target : 'other';
      return `agent/inbox/spliced(${target}:${data.inserted.map((item) => sourceKind(record(record(item).source).kind)).join(',')})`;
    }
    return String(event.type);
  });
  const status =
    starts.length > 1
      ? '唤醒次数不符'
      : environmentMessages > 1
        ? '环境投递次数不符'
        : start && (settled < 0 || tail.indexOf(start) < settled)
          ? '后台失败前已有新轮次'
          : settled < 0
            ? '等待后台失败'
            : !start
              ? '等待唤醒超时'
              : !end
                ? '唤醒已发生但回复未完成'
                : environmentMessages !== 1 || turnMessages !== 1
                  ? '环境投递次数不符'
                  : reason.kind !== 'completed' || !text.some((part) => part.trim())
                    ? '回复有错误'
                    : '完成';
  return {
    status,
    wakeCount: starts.length,
    environmentMessages,
    turnMessages,
    replyLength: text.reduce((sum, part) => sum + part.length, 0),
    wakeTurnEnd: reason.kind ?? null,
    wakeErrorCode: record(reason.error).code ?? null,
    sequence,
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
