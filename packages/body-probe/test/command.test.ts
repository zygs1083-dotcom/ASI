import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { drainCommands, type ExecFn, runCommand } from '../src/command.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runCommand', () => {
  it('coalesces identical simultaneous calls into one exec invocation', async () => {
    const d = deferred<{ stdout: string }>();
    const exec = vi.fn<ExecFn>(() => d.promise);
    const p1 = runCommand('/bin/fake', ['a'], exec);
    const p2 = runCommand('/bin/fake', ['a'], exec);
    expect(exec).toHaveBeenCalledTimes(1);
    d.resolve({ stdout: 'out' });
    expect(await p1).toBe('out');
    expect(await p2).toBe('out');
  });

  it('does not alias args that collapse under string join', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: 'x' }));
    await Promise.all([runCommand('/bin/fake', ['a b'], exec), runCommand('/bin/fake', ['a', 'b'], exec)]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce different args', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: 'x' }));
    await Promise.all([runCommand('/bin/fake', ['a'], exec), runCommand('/bin/fake', ['b'], exec)]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('removes the in-flight entry so a retry after error calls exec again', async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ stdout: 'ok' });
    await expect(runCommand('/bin/fake', [], exec)).rejects.toThrow('boom');
    expect(await runCommand('/bin/fake', [], exec)).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('passes a bounded 1s/SIGKILL/4MB/LC_ALL=C option set without a shell', async () => {
    let captured: Record<string, unknown> | undefined;
    const exec = vi.fn<ExecFn>(async (_f, _a, opts) => {
      captured = opts as unknown as Record<string, unknown>;
      return { stdout: '' };
    });
    await runCommand('/bin/fake', ['x'], exec);
    expect(captured?.timeout).toBe(1000);
    expect(captured?.killSignal).toBe('SIGKILL');
    expect(captured?.maxBuffer).toBe(4 * 1024 * 1024);
    const env = captured?.env as NodeJS.ProcessEnv;
    expect(env.LC_ALL).toBe('C');
    expect(env.LANG).toBe('C');
    expect(captured?.shell).toBeFalsy();
  });

  it('rejects when exec rejects (collectors convert to facts)', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('killed'), { code: 'SIGKILL' });
    });
    await expect(runCommand('/bin/fake', [], exec)).rejects.toThrow('killed');
  });
});

describe('runCommand cancellation', () => {
  it('serializes an identical command across different signals, retrying after settle', async () => {
    const execs: ReturnType<typeof deferred<{ stdout: string }>>[] = [];
    const exec = vi.fn<ExecFn>(() => {
      const d = deferred<{ stdout: string }>();
      execs.push(d);
      return d.promise;
    });
    const p1 = runCommand('/bin/f', ['a'], exec, new AbortController().signal);
    const p2 = runCommand('/bin/f', ['a'], exec, new AbortController().signal);
    expect(exec).toHaveBeenCalledTimes(1);
    execs[0]!.resolve({ stdout: 'one' });
    expect(await p1).toBe('one');
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 5 });
    execs[1]!.resolve({ stdout: 'two' });
    expect(await p2).toBe('two');
  });

  it('never executes pre-aborted or wait-cancelled requests', async () => {
    const d = deferred<{ stdout: string }>();
    const exec = vi.fn<ExecFn>(() => d.promise);
    const pre = new AbortController();
    pre.abort();
    await expect(runCommand('/bin/f', ['a'], exec, pre.signal)).rejects.toThrow(/abort/i);
    const queued = new AbortController();
    const p1 = runCommand('/bin/f', ['a'], exec);
    const p2 = runCommand('/bin/f', ['a'], exec, queued.signal);
    p2.catch(() => {}); // silence until asserted below
    try {
      queued.abort();
      // our waiter settles on our own abort, without waiting for p1's command
      await expect(p2).rejects.toThrow(/abort/i);
      expect(exec).toHaveBeenCalledTimes(1); // only p1 ever ran
    } finally {
      d.resolve({ stdout: 'x' });
      await p1;
    }
    expect(exec).toHaveBeenCalledTimes(1); // aborted waiter never retried
  });

  it('drainCommands waits only for commands under the drained signal', async () => {
    const d = deferred<{ stdout: string }>();
    const c = new AbortController();
    const pending = runCommand(
      '/bin/f',
      [],
      vi.fn<ExecFn>(() => d.promise),
      c.signal,
    );
    pending.catch(() => {});
    let drained = false;
    const draining = drainCommands(c.signal).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    d.resolve({ stdout: 'ok' });
    await draining;
    expect(drained).toBe(true);
    expect(await pending).toBe('ok');
  });

  it('rejects an aborted real command only after the child exits', async () => {
    const pidFile = path.join(os.tmpdir(), `body-probe-${process.pid}.pid`);
    const controller = new AbortController();
    const pending = runCommand(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 6e4);`,
      ],
      undefined,
      controller.signal,
    );
    pending.catch(() => {});
    let pid = 0;
    try {
      await vi.waitFor(
        () => {
          pid = Number(fs.readFileSync(pidFile, 'utf8'));
        },
        { timeout: 5000, interval: 20 },
      );
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(() => process.kill(pid, 0)).toThrowError(/ESRCH/);
    } finally {
      controller.abort();
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      fs.rmSync(pidFile, { force: true });
    }
  });
});
