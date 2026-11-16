import { describe, expect, it } from 'vitest';
import { mapJobEvent, mapToolEvent } from '../../src/host/dsh/events.ts';

const execution = {
  sessionId: 'session',
  toolCallId: 'call',
  name: 'bash',
  args: { command: 'false', workdir: '/tmp/fixture' },
};
const job = {
  id: 'job',
  kind: 'bash',
  label: 'false',
  startedAt: 100,
  finishedAt: 200,
  status: 'completed',
  detail: 'exit code: 1',
};

describe('DSH event mapping', () => {
  it('carries the bash result exit code and workdir without reading tool output', () => {
    expect(mapToolEvent('pre-execute', execution)).toMatchObject({
      type: 'pre-execute',
      sessionId: 'session',
      toolCallId: 'call',
      command: 'false',
      cwd: '/tmp/fixture',
    });
    expect(
      mapToolEvent('post-execute', execution, { kind: 'foreground', cwd: '/tmp/fixture', exitCode: 1 }),
    ).toMatchObject({
      type: 'post-execute',
      exitCode: 1,
      cwd: '/tmp/fixture',
    });
    expect(
      mapToolEvent('post-execute', { ...execution, name: 'write_file' }, { exitCode: 1 })?.exitCode,
    ).toBeUndefined();
    expect(
      mapToolEvent('pre-execute', { ...execution, name: 'write_file', args: {}, defaultCwd: '/tmp/fixture' }).cwd,
    ).toBe('/tmp/fixture');
  });

  it('records job start and terminal state without duplicating awaited shell failures', () => {
    expect(mapJobEvent({ type: 'registered', job })).toEqual({
      type: 'started',
      id: 'job',
      command: 'false',
      at: 100,
    });
    expect(mapJobEvent({ type: 'settled', job, awaited: false })).toEqual({
      type: 'exited',
      id: 'job',
      command: 'false',
      at: 200,
      exitCode: 1,
    });
    expect(mapJobEvent({ type: 'settled', job, awaited: true })).toEqual({
      type: 'exited',
      id: 'job',
      command: 'false',
      at: 200,
    });
  });

  it('does not invent exit codes for unsupported jobs or non-exit outcomes', () => {
    expect(mapJobEvent({ type: 'settled', job: { ...job, kind: 'other' }, awaited: false })?.exitCode).toBeUndefined();
    expect(
      mapJobEvent({ type: 'settled', job: { ...job, detail: 'cancelled' }, awaited: false })?.exitCode,
    ).toBeUndefined();
    expect(mapJobEvent({ type: 'progress', job })).toBeUndefined();
  });
});
