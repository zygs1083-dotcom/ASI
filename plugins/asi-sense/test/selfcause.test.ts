import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { classifyCause as classifyReceived, type ToolWindow } from '../src/host/attention/selfcause.ts';
import { sig } from './helpers.ts';

const W: ToolWindow = { startedAt: 100, endedAt: 200, cwd: '/repo', pid: 42 };
const classifyCause = (signal: Signal, windows: ToolWindow[], grace = 0, receipt = signal.at) =>
  classifyReceived(
    signal,
    windows.map((window) => ({
      ...window,
      startedMono: window.startedMono ?? window.startedAt,
      endedMono: window.endedMono ?? window.endedAt,
    })),
    grace || (receipt === signal.at ? 1 : 0),
    receipt,
  );

describe('classifyCause', () => {
  it('marks file.changed under an active tool cwd as agent', () => {
    const s = sig({
      id: '1',
      kind: 'file.changed',
      at: 150,
      subject: '/repo/src/a.ts',
    });
    expect(classifyCause(s, [W])).toBe('agent');
    expect(classifyCause(s, [])).toBe('unknown');
  });

  it('uses data.path over subject for file changes', () => {
    const s = sig({
      id: '1',
      kind: 'file.changed',
      at: 150,
      subject: '/else/x',
      data: { path: '/repo/b' },
    });
    expect(classifyCause(s, [W])).toBe('agent');
  });

  it('respects inclusive time bounds and closed windows', () => {
    const inW = sig({
      id: '1',
      kind: 'file.changed',
      at: 200,
      subject: '/repo/a',
    });
    const late = sig({
      id: '2',
      kind: 'file.changed',
      at: 201,
      subject: '/repo/a',
    });
    const early = sig({
      id: '3',
      kind: 'file.changed',
      at: 99,
      subject: '/repo/a',
    });
    expect(classifyCause(inW, [W])).toBe('agent');
    expect(classifyCause(late, [W])).toBe('unknown');
    expect(classifyCause(early, [W])).toBe('unknown');
    const open: ToolWindow = { startedAt: 100, cwd: '/repo' };
    expect(classifyCause(late, [open])).toBe('agent');
  });

  it('does not match prefix-only cwd (/repo vs /repository)', () => {
    const s = sig({
      id: '1',
      kind: 'file.changed',
      at: 150,
      subject: '/repository/a',
    });
    expect(classifyCause(s, [W])).toBe('unknown');
    const exact = sig({
      id: '2',
      kind: 'file.changed',
      at: 150,
      subject: '/repo',
    });
    expect(classifyCause(exact, [W])).toBe('agent');
  });

  it('matches job/process signals by pid and cwd', () => {
    const byPid = sig({
      id: '1',
      kind: 'job.exited',
      at: 150,
      data: { pid: 42 },
    });
    const wrongPid = sig({
      id: '2',
      kind: 'job.exited',
      at: 150,
      data: { pid: 43 },
    });
    const startByCwd = sig({
      id: '3',
      kind: 'process.started',
      at: 150,
      data: { path: '/repo/bin/x' },
    });
    const procExit = sig({
      id: '4',
      kind: 'process.exited',
      at: 150,
      data: { pid: 42 },
    });
    expect(classifyCause(byPid, [W])).toBe('agent');
    expect(classifyCause(wrongPid, [W])).toBe('unknown');
    expect(classifyCause(startByCwd, [W])).toBe('agent');
    expect(classifyCause(procExit, [W])).toBe('agent');
  });

  it('preserves explicit agent cause and upgrades user/unknown only on match', () => {
    const unrelated = sig({
      id: '1',
      kind: 'app.activated',
      at: 150,
      cause: 'agent',
    });
    expect(classifyCause(unrelated, [])).toBe('agent');
    const userFile = sig({
      id: '2',
      kind: 'file.changed',
      at: 150,
      subject: '/repo/a',
      cause: 'user',
    });
    expect(classifyCause(userFile, [W])).toBe('agent');
    const userOutside = sig({
      id: '3',
      kind: 'file.changed',
      at: 500,
      subject: '/repo/a',
      cause: 'user',
    });
    expect(classifyCause(userOutside, [W])).toBe('user');
    const app = sig({ id: '4', kind: 'app.activated', at: 150, cause: 'user' });
    expect(classifyCause(app, [W])).toBe('user');
  });

  it("matches '..'-prefixed names inside cwd but never real parent traversal", () => {
    const inside = sig({
      id: '1',
      kind: 'file.changed',
      at: 150,
      subject: '/repo/..notes/a.ts',
    });
    expect(classifyCause(inside, [W])).toBe('agent');
    const traversal = sig({
      id: '2',
      kind: 'file.changed',
      at: 150,
      subject: '/repo/../outside.ts',
    });
    expect(classifyCause(traversal, [W])).toBe('unknown');
    const sibling = sig({
      id: '3',
      kind: 'file.changed',
      at: 150,
      subject: '/repository/a.ts',
    });
    expect(classifyCause(sibling, [W])).toBe('unknown');
  });

  it('rejects relative signal paths instead of resolving against process cwd', () => {
    const rel = sig({
      id: '1',
      kind: 'file.changed',
      at: 150,
      subject: 'src/a.ts',
    });
    expect(classifyCause(rel, [W])).toBe('unknown');
    const relWin: ToolWindow = { startedAt: 0, cwd: 'repo/sub' };
    expect(classifyCause(rel, [relWin])).toBe('unknown');
  });

  it('limits trailing grace to cwd files and same-pid job exits using receipt time', () => {
    const window: ToolWindow = { ...W, startedMono: 10, endedMono: 110 };
    const file = sig({ id: 'f', kind: 'file.changed', at: 2_200, subject: '/repo/a', cause: 'user' });
    expect(classifyReceived({ ...file, at: 150 }, [W], 2_000)).toBe('user');
    expect(classifyCause(file, [window], 2_000, 2_110)).toBe('user');
    expect(classifyCause(file, [window], 2_000, 2_109)).toBe('agent');
    expect(classifyCause({ ...file, at: 2_199 }, [window], 2_000, 2_110)).toBe('user');
    expect(classifyCause({ ...file, at: 150 }, [window], 2_000, 9_000)).toBe('user');
    expect(classifyCause({ ...file, at: 99 }, [window], 2_000, 2_110)).toBe('user');
    expect(classifyCause({ ...file, subject: '/repository/a', data: { pid: 42 } }, [window], 2_000, 111)).toBe('user');
    expect(classifyCause({ ...file, kind: 'job.exited', at: 201, data: { pid: 42 } }, [window], 2_000, 111)).toBe(
      'agent',
    );
    expect(classifyCause({ ...file, at: 201 }, [window], 0, 111)).toBe('user');
  });

  it('does not extend descendant, cwd-only, started or process events beyond a tool window', () => {
    const window: ToolWindow = { ...W, startedMono: 10, endedMono: 110 };
    const event = sig({ id: 'j', kind: 'job.exited', at: 201, data: { pid: 43, ppid: 42, path: '/repo' } });
    for (const receipt of [110, 111]) {
      expect(classifyReceived(event, [window], 2_000, receipt)).toBe('unknown');
      expect(classifyReceived({ ...event, data: { ancestors: [42], path: '/repo' } }, [window], 2_000, receipt)).toBe(
        'unknown',
      );
    }
    expect(classifyReceived({ ...event, kind: 'job.started', data: { pid: 42 } }, [window], 2_000, 111)).toBe(
      'unknown',
    );
    expect(classifyReceived({ ...event, kind: 'process.exited', data: { pid: 42 } }, [window], 2_000, 111)).toBe(
      'unknown',
    );
    expect(classifyReceived({ ...event, data: { pid: 42 } }, [window], 2_000, 2_109)).toBe('agent');
    expect(classifyReceived({ ...event, data: { pid: 42 } }, [window], 2_000, 2_110)).toBe('unknown');
    expect(classifyReceived({ ...event, data: { pid: 42 } }, [window], 0, 111)).toBe('unknown');
  });
});
