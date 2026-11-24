import { describe, expect, it } from 'vitest';
import { awaitedJobCwd, JobEventCorrelator, mapJobEvent, mapToolEvent } from '../../../src/sense/host/dsh/events.ts';

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

  it('associates awaited job settlement only with the owning active tool', () => {
    const event = { type: 'settled', job: { ...job, owner: 'session' }, awaited: true };
    const tool = { sessionId: 'session', name: 'bash', command: 'false', cwd: '/tmp/fixture' };
    expect(awaitedJobCwd(event, [tool])).toBe('/tmp/fixture');
    expect(mapJobEvent(event, awaitedJobCwd(event, [tool]))).toMatchObject({
      type: 'exited',
      cwd: '/tmp/fixture',
    });
    expect(awaitedJobCwd({ ...event, awaited: false }, [tool])).toBeUndefined();
    expect(awaitedJobCwd(event, [])).toBeUndefined();
    expect(awaitedJobCwd(event, [{ ...tool, sessionId: 'other' }])).toBeUndefined();
    expect(awaitedJobCwd(event, [{ ...tool, command: 'other' }])).toBeUndefined();
    expect(awaitedJobCwd({ ...event, job: { ...job } }, [tool])).toBeUndefined();
  });

  it('associates an awaited job output with the specific waiting tool', () => {
    const event = { type: 'settled', job: { ...job, owner: 'session' }, awaited: true };
    const tool = { sessionId: 'session', name: 'job_output', jobId: 'job', waitsForJob: true, cwd: '/tmp/fixture' };
    expect(awaitedJobCwd(event, [tool])).toBe('/tmp/fixture');
    expect(awaitedJobCwd(event, [{ ...tool, jobId: 'other' }])).toBeUndefined();
    expect(awaitedJobCwd(event, [{ ...tool, waitsForJob: false }])).toBeUndefined();
  });

  it('retains the originating tool identity when identical commands overlap', () => {
    const original = { sessionId: 'session', name: 'bash', command: 'false', cwd: '/tmp/fixture' };
    const tools = new Map([['first', original]]);
    const correlator = new JobEventCorrelator(tools);
    const owned = { ...job, owner: 'session' };
    correlator.map({ type: 'registered', job: owned });
    tools.delete('first');
    tools.set('second', original);
    expect(correlator.map({ type: 'settled', job: owned, awaited: true })?.cwd).toBeUndefined();
  });

  it('does not associate a job when parallel registrations are ambiguous', () => {
    const tool = { sessionId: 'session', name: 'bash', command: 'false', cwd: '/tmp/fixture' };
    const tools = new Map([
      ['first', tool],
      ['second', tool],
    ]);
    const correlator = new JobEventCorrelator(tools);
    const owned = { ...job, owner: 'session' };
    correlator.map({ type: 'registered', job: owned });
    tools.delete('second');
    expect(correlator.map({ type: 'settled', job: owned, awaited: true })?.cwd).toBeUndefined();
  });

  it('attributes a settled job to its still-active originating tool', () => {
    const tool = { sessionId: 'session', name: 'bash', command: 'false', cwd: '/tmp/fixture' };
    const correlator = new JobEventCorrelator(new Map([['first', tool]]));
    const owned = { ...job, owner: 'session' };
    expect(correlator.map({ type: 'registered', job: owned })).toMatchObject({ type: 'started' });
    expect(correlator.map({ type: 'settled', job: owned, awaited: true })).toMatchObject({
      type: 'exited',
      cwd: '/tmp/fixture',
    });
    expect(correlator.map({ type: 'settled', job: owned, awaited: true })?.cwd).toBeUndefined();
  });
});
