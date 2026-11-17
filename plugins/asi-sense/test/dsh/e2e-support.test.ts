import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  failureDetails,
  stop,
  targetTurnOutcome,
  temporaryProfile,
  wakeDiagnostics,
} from '../../scripts/e2e-support.ts';

describe('private failure diagnostics', () => {
  it('reports assertion values without copying arbitrary error or matcher content', () => {
    const error = Object.assign(new Error('private message'), {
      matcherResult: { expected: 1, actual: 2, message: 'private matcher content' },
    });
    const details = failureDetails(error);
    expect(details).toMatchObject({ name: 'Error', expected: 1, actual: 2 });
    expect(JSON.stringify(details)).not.toContain('private');
    expect(failureDetails(new Error('target assertion selected count: expected=1, actual=2'))).toMatchObject({
      assertion: 'target assertion selected count: expected=1, actual=2',
    });
  });

  it('distinguishes the fixture budget gate from real model failures', () => {
    const end = (kind: string, message?: string) => ({
      type: 'turn/end',
      data: { reason: { kind, error: message ? { code: 'UNKNOWN', message } : undefined } },
    });
    expect(targetTurnOutcome([end('completed')], 1)).toBeUndefined();
    expect(targetTurnOutcome([end('completed')], 0)).toBe('completed');
    expect(targetTurnOutcome([end('error', 'E2E model request budget exhausted')], 0)).toBe('budget-exhausted');
    expect(targetTurnOutcome([end('error', 'provider failed')], 0)).toBe('failed');
  });
});

describe('woken model turn diagnostics', () => {
  const start = (turn: number) => ({ type: 'turn/start', data: { turn } });
  const environment = { type: 'user/message', data: { source: { kind: 'environment' } } };
  const followup = {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', inserted: [{ source: { kind: 'environment' } }] },
  };
  const job = {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', inserted: [{ source: { kind: 'tool-jobs' } }] },
  };
  const assistant = (turn: number, text: string) => ({
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
  });
  const end = (turn: number, kind: string) => ({ type: 'turn/end', data: { turn, reason: { kind } } });
  const initial = [
    start(1),
    assistant(1, 'ready'),
    end(1, 'completed'),
    {
      type: 'job/settled',
      data: { kind: 'bash', label: 'sleep 20; exit 1', status: 'completed', detail: 'exit code: 1' },
    },
  ];

  it('distinguishes a missing turn from a turn whose reply has not finished', () => {
    expect(wakeDiagnostics(initial, 1)).toMatchObject({
      status: '等待唤醒超时',
      wakeCount: 0,
    });
    expect(wakeDiagnostics([...initial, start(2), environment], 1)).toMatchObject({
      status: '唤醒已发生但回复未完成',
      wakeCount: 1,
    });
  });

  it.each([followup, job])('accepts one environment message in a completed turn regardless of trigger', (trigger) => {
    expect(
      wakeDiagnostics([...initial, trigger, start(2), environment, assistant(2, 'ACK'), end(2, 'completed')], 1),
    ).toMatchObject({
      status: '完成',
      wakeCount: 1,
      environmentMessages: 1,
      replyLength: 3,
      wakeTurnEnd: 'completed',
    });
  });

  it('rejects missing, duplicated or out-of-turn delivery, duplicate turns, and bad replies', () => {
    expect(wakeDiagnostics([...initial, start(2), end(2, 'completed')], 1)).toMatchObject({
      status: '环境投递次数不符',
    });
    expect(wakeDiagnostics([...initial, start(2), environment, environment, end(2, 'completed')], 1)).toMatchObject({
      status: '环境投递次数不符',
    });
    expect(
      wakeDiagnostics([...initial, environment, start(2), assistant(2, 'ACK'), end(2, 'completed')], 1),
    ).toMatchObject({ status: '环境投递次数不符' });
    expect(wakeDiagnostics([...initial, environment, start(2), environment], 1)).toMatchObject({
      status: '环境投递次数不符',
    });
    expect(wakeDiagnostics([...initial, start(2), environment, end(2, 'error')], 1)).toMatchObject({
      status: '回复有错误',
    });
    expect(
      wakeDiagnostics([...initial, start(2), environment, assistant(2, ' '), end(2, 'completed')], 1),
    ).toMatchObject({ status: '回复有错误' });
    expect(
      wakeDiagnostics([...initial, start(2), environment, assistant(1, 'ACK'), end(2, 'completed')], 1),
    ).toMatchObject({ status: '回复有错误' });
    expect(
      wakeDiagnostics([...initial, start(2), environment, assistant(2, 'ACK'), end(2, 'completed'), start(3)], 1),
    ).toMatchObject({ status: '唤醒次数不符', wakeCount: 2 });
  });

  it('requires the specified background failure before the new turn', () => {
    const beforeFailure = initial.slice(0, -1);
    expect(wakeDiagnostics(beforeFailure, 1)).toMatchObject({ status: '等待后台失败' });
    expect(
      wakeDiagnostics([...beforeFailure, start(2), initial[initial.length - 1], environment, end(2, 'completed')], 1),
    ).toMatchObject({ status: '后台失败前已有新轮次' });
    const wrongExit = {
      type: 'job/settled',
      data: { kind: 'bash', label: 'sleep 20; exit 1', status: 'completed', detail: 'exit code: 0' },
    };
    expect(wakeDiagnostics([...beforeFailure, wrongExit], 1)).toMatchObject({ status: '等待后台失败' });
  });

  it('prints event types and source kinds without message content', () => {
    const result = wakeDiagnostics(
      [...initial, job, start(2), environment, assistant(2, 'private content'), end(2, 'completed')],
      1,
    );
    expect(result.sequence).toEqual([
      'job/settled',
      'agent/inbox/spliced(next-turn:tool-jobs)',
      'turn/start',
      'user/message(environment)',
      'assistant/message',
      'turn/end',
    ]);
    expect(JSON.stringify(result)).not.toContain('private content');
  });
});

describe('private DSH fixture profile', () => {
  it('retains a failed fixture until explicitly removed after exit', async () => {
    let root = '';
    try {
      await (async () => {
        await using profile = await temporaryProfile();
        root = profile.root;
        await writeFile(`${root}/fixture`, 'invented data');
        profile.retain();
      })();
      await expect(access(`${root}/fixture`)).resolves.toBeUndefined();
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['success', 'execution failure', 'initialization failure'])('removes the profile after %s', async (phase) => {
    let profile = '';
    const run = (async () => {
      await using temp = await temporaryProfile();
      profile = temp.root;
      if (phase !== 'initialization failure') await writeFile(`${temp.root}/fixture`, 'invented data');
      if (phase !== 'success') throw new Error(phase);
    })();
    if (phase === 'success') await run;
    else await expect(run).rejects.toThrow(phase);
    expect(profile).not.toBe('');
    await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Spawns a real `tsx` subprocess; under CPU load the startup alone can
  // exceed vitest's default 5s timeout.
  it('removes the actual fixture profile when DSH initialization fails', { timeout: 30_000 }, async () => {
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('../../scripts/e2e-dsh.ts', import.meta.url))],
      { env: { ...process.env, DSH_ROOT: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      output += text;
    });
    child.stderr.resume();
    const [code, signal] = await once(child, 'exit');
    expect(signal).toBeNull();
    expect(code).not.toBe(0);
    expect(output).toContain('Temporary profile removed: yes');
  });

  // Same reason as above: real `tsx` subprocess startup under load.
  it('removes the danger fixture profile when initialization fails', { timeout: 30_000 }, async () => {
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./danger-e2e.ts', import.meta.url))],
      { env: { ...process.env, DSH_ROOT: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      output += text;
    });
    child.stderr.resume();
    const [code, signal] = await once(child, 'exit');
    expect(signal).toBeNull();
    expect(code).not.toBe(0);
    expect(output).toContain('Temporary profile removed: yes');
  });
});

describe.skipIf(process.platform === 'win32')('DSH fixture process group', () => {
  it('terminates and waits for a stubborn child after its parent has exited', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
         child.stdout.once('data', () => { console.log(child.pid); process.exit(0); });`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const exited = once(parent, 'exit');
    try {
      const [output] = await once(parent.stdout, 'data');
      const pid = Number(String(output).trim());
      expect(pid).toBeGreaterThan(0);
      await exited;
      process.kill(pid, 0);
      await stop(parent, 100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (parent.pid) {
        await stop(parent, 100);
      }
    }
  });
});
