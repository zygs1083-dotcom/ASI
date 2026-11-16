import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stop, temporaryProfile } from '../../scripts/e2e-support.ts';

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
