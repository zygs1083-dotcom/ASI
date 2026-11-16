import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stop, temporaryProfile, wakeDiagnostics } from '../../scripts/e2e-support.ts';

describe('woken model turn diagnostics', () => {
  const wake = {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', inserted: [{ source: { kind: 'environment' } }] },
  };
  const assistant = (turn: number, text: string) => ({
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
  });
  const end = (turn: number, kind: string) => ({ type: 'turn/end', data: { turn, reason: { kind } } });

  it('distinguishes a missing wake from a wake whose reply has not finished', () => {
    const initial = [assistant(1, 'ready'), end(1, 'completed')];
    expect(wakeDiagnostics(initial)).toMatchObject({
      status: '等待唤醒超时',
      wakeCount: 0,
      lastAssistantLength: 5,
      lastTurnEnd: 'completed',
    });
    expect(wakeDiagnostics([...initial, wake])).toMatchObject({
      status: '唤醒已发生但回复未完成',
      wakeCount: 1,
      wakeTurnEnd: null,
    });
  });

  it('distinguishes a failed, empty, or successful woken turn', () => {
    expect(wakeDiagnostics([wake, end(2, 'error')])).toMatchObject({ status: '回复有错误', wakeTurnEnd: 'error' });
    expect(wakeDiagnostics([wake, assistant(2, ''), end(2, 'completed')])).toMatchObject({ status: '回复有错误' });
    expect(wakeDiagnostics([wake, assistant(2, 'ACK'), end(2, 'completed')])).toMatchObject({
      status: '完成',
      wakeCount: 1,
      lastAssistantLength: 3,
      wakeTurnEnd: 'completed',
    });
    expect(wakeDiagnostics([wake, wake])).toMatchObject({ status: '唤醒次数不符', wakeCount: 2 });
  });
});

describe('private DSH fixture profile', () => {
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

  it('removes the actual fixture profile when DSH initialization fails', async () => {
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

  it('removes the danger fixture profile when initialization fails', async () => {
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
