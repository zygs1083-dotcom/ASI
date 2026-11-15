import { describe, expect, it, vi } from 'vitest';
import { runCommand, type ExecFn } from '../src/command.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
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
    await Promise.all([
      runCommand('/bin/fake', ['a b'], exec),
      runCommand('/bin/fake', ['a', 'b'], exec),
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce different args', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: 'x' }));
    await Promise.all([runCommand('/bin/fake', ['a'], exec), runCommand('/bin/fake', ['b'], exec)]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('removes the in-flight entry so a retry after error calls exec again', async () => {
    const exec = vi.fn<ExecFn>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ stdout: 'ok' });
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
    const exec = vi.fn<ExecFn>(async () => { throw Object.assign(new Error('killed'), { code: 'SIGKILL' }); });
    await expect(runCommand('/bin/fake', [], exec)).rejects.toThrow('killed');
  });
});
