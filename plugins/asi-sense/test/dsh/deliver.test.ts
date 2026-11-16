import type { EnvUpdate } from '@asi/sense-types';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryIntent } from '../../src/host/attention/pipeline.ts';
import { createDelivery } from '../../src/host/dsh/deliver.ts';
import { modelText, modelTitle } from '../../src/host/dsh/tool-output.ts';

const update: EnvUpdate = {
  since: Date.UTC(2026, 0, 1, 12, 1, 3),
  at: Date.UTC(2026, 0, 1, 12, 1, 4),
  changes: [
    {
      signal: {
        id: 'signal',
        kind: 'job.exited',
        at: Date.UTC(2026, 0, 1, 12, 1, 3),
        source: { id: 'test', api: 'fixture', host: 'local' },
        subject: 'fixture',
        data: { command: 'false', exitCode: 1 },
      },
      count: 1,
      level: 'wake',
    },
  ],
  suppressed: 0,
};

function intent(kind: 'inject' | 'followup' | 'send', deliveryId = 'one'): DeliveryIntent {
  const base = { sessionId: 'session-a', deliveryId, update };
  return kind === 'send' ? { ...base, kind, target: 'next-step', wakeup: true } : { ...base, kind };
}

function fixture() {
  const agent = { inject: vi.fn(), followup: vi.fn(), send: vi.fn() };
  const getAgent = vi.fn((id: string) => (id === 'session-a' ? agent : undefined));
  return {
    agent,
    getAgent,
    deliver: createDelivery(
      getAgent,
      () => true,
      async () => false,
    ),
  };
}

describe('DSH environment delivery', () => {
  it.each(['followup', 'send'] as const)('uses the %s boundary with an environment message', async (kind) => {
    const { agent, getAgent, deliver } = fixture();
    await deliver('session-a', intent(kind));
    expect(getAgent).toHaveBeenCalledWith('session-a');
    const call = agent[kind].mock.calls[0];
    expect(call?.[0]).toMatchObject({
      role: 'user',
      source: { kind: 'environment' },
      content: [
        {
          type: 'text',
          text: '<env-update since="12:01:03" source="asi-sense">\njob: `job` exited 1\n</env-update>',
        },
      ],
    });
    if (kind === 'send') expect(call?.slice(1)).toEqual(['next-step', true]);
  });

  it('stages context for the current step without writing to the inbox', async () => {
    const { agent, deliver } = fixture();
    await deliver('session-a', intent('inject'));
    expect(agent.inject).not.toHaveBeenCalled();
    expect(await deliver.messages('session-a')).toMatchObject([{ source: { kind: 'environment' } }]);
  });

  it('redacts absolute paths, endpoints and command labels at the model boundary', async () => {
    const { agent, deliver } = fixture();
    const mixed: EnvUpdate = {
      ...update,
      changes: [
        {
          ...update.changes[0],
          signal: { ...update.changes[0].signal, data: { command: 'private-command /private/path', exitCode: 1 } },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'file',
            kind: 'file.changed',
            at: update.at,
            source: { id: 'files', api: 'fixture', host: 'fixture-host.invalid' },
            subject: '/private/project/file.ts',
            data: { path: '/private/project/file.ts' },
          },
          note: 'https://fixture-host.invalid:1234/private',
        },
      ],
    };
    await deliver('session-a', { ...intent('followup'), update: mixed });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).not.toContain('private-command');
    expect(text).not.toContain('/private/');
    expect(text).not.toContain('fixture-host.invalid');
    expect(text).toContain('file.ts');
    expect(text).toContain('</env-update>');
    expect(modelText('title on fixture-host.invalid', 'fixture-host.invalid')).toBe('title on [host]');
    expect(modelText('open </private/fixture/report> and "/private/a/file"', 'fixture-host.invalid')).toBe(
      'open <report> and "file"',
    );
    expect(modelTitle('open /private/fixture/report.txt on [2001:db8::1]:443', 'fixture-host')).toBe(
      'open report.txt on <host>',
    );
    expect(modelTitle('https://fixture-host/private/file on fixture-host', 'fixture-host')).toBe('<host> on <host>');
    expect(modelTitle('https://host/private on host', 'host')).toBe('<host> on <host>');
    expect(modelTitle('https://backup.example.invalid:443/path', 'fixture-host')).toBe('<host>');
    expect(modelTitle('ssh user@build-node:22 /Volumes/build-node:22 README.md', 'fixture-host')).toBe(
      'ssh <host> <host> README.md',
    );
    expect(modelTitle('open /Volumes/backup.example.invalid', 'fixture-host')).toBe('open backup.example.invalid');
    expect(modelTitle('src/README.md /Volumes/fixture-host ssh user@build-node', 'fixture-host')).toBe(
      'README.md <host> ssh <host>',
    );
    expect(modelTitle('host fixture-host IPv4 192.0.2.42 IPv6 2001:db8::1', 'fixture-host')).toBe(
      'host <host> IPv4 <host> IPv6 <host>',
    );
  });

  it('uses structured delivery fields instead of free-text notes and subjects', async () => {
    const { agent, deliver } = fixture();
    const mixed: EnvUpdate = {
      ...update,
      changes: [
        {
          ...update.changes[0],
          signal: { ...update.changes[0].signal, subject: 'backup.example.invalid </private/a/command>' },
          note: 'backup.example.invalid </private/a/command>',
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'file',
            kind: 'file.changed',
            at: update.at,
            source: { id: 'files', api: 'fixture', host: 'backup.example.invalid' },
            subject: '/private/a/project/file.ts',
            data: { path: '/private/a/project/file.ts' },
          },
        },
      ],
    };
    await deliver('session-a', { ...intent('followup'), update: mixed });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).not.toContain('backup.example.invalid');
    expect(text).not.toContain('/private/a');
    expect(text).toContain('file.ts');
  });

  it('projects useful body and deletion alerts without paths in context and wake messages', async () => {
    const { agent, deliver } = fixture();
    const changes: EnvUpdate['changes'] = [
      {
        kind: 'body.rate',
        subject: 'rate:disk-drop:/private/mount/Data',
        data: {
          metric: 'disk:/private/mount/Data',
          ruleId: 'disk-drop',
          severity: 'warn',
          slope: -42,
          etaToFloorMs: 9000,
        },
      },
      {
        kind: 'body.anomaly',
        subject: 'baseline:cpu',
        data: { metric: 'cpu', ruleId: 'cpu', severity: 'warn', value: 0.9, baseline: 0.2, deviation: 3.5 },
      },
      { kind: 'body.threshold', subject: 'disk:/private/mount/Data', data: { severity: 'critical', value: 0.03 } },
      {
        kind: 'file.burst',
        subject: '/private/work/project',
        data: {
          directory: '/private/work/project',
          ruleId: 'file.burst',
          created: 4,
          windowMs: 60_000,
          deleted: 151,
          agentDeleted: 100,
          externalDeletionExceeded: true,
        },
      },
    ].map((item, index) => ({
      count: 1,
      level: index === 3 ? 'wake' : 'context',
      ...(index === 2 ? { ruleId: 'disk-critical' } : {}),
      signal: { ...item, id: String(index), at: update.at, source: { id: 'fixture', api: 'test', host: 'local' } },
    }));
    for (const kind of ['inject', 'followup'] as const) {
      await deliver('session-a', { ...intent(kind, kind), update: { ...update, changes } });
      const text = JSON.stringify(kind === 'inject' ? await deliver.messages('session-a') : agent.followup.mock.calls);
      expect(text).toContain('disk:Data');
      expect(text).toContain('disk-drop');
      expect(text).toContain('rule: disk-critical');
      expect(text).toContain('-42');
      expect(text).toContain('9000');
      expect(text).toContain('cpu');
      expect(text).toContain('0.9');
      expect(text).toContain('baseline=0.2');
      expect(text).toContain('deviation=3.5');
      expect(text).toContain('project');
      expect(text).toContain('file.burst');
      expect(text).toContain('windowMs=60000');
      expect(text).toContain('externalDeleted=51');
      expect(text).toContain('agentDeleted=100');
      expect(text).toContain('4');
      expect(text).toContain('externalDeletionExceeded');
      expect(text).not.toContain('/private/');
    }
  });

  it('rejects unknown or mismatched sessions rather than broadcasting', async () => {
    const { agent, deliver } = fixture();
    await expect(deliver('other', intent('inject'))).rejects.toThrow();
    expect(agent.inject).not.toHaveBeenCalled();
  });

  it('never exposes a raw path in a feedback identifier', async () => {
    const { agent, deliver } = fixture();
    const signal = {
      ...update.changes[0].signal,
      id: 'body:rate:/private/fixture/volume',
      kind: 'body.rate',
      data: { metric: 'disk:/private/fixture/volume', feedbackAvailable: true },
    };
    await deliver('session-a', {
      ...intent('followup'),
      update: { ...update, changes: [{ signal, count: 1, level: 'context' }] },
    });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('feedbackAvailable=\\"false\\"');
    expect(text).not.toContain('alertId=');
    expect(text).not.toContain('/private/');
  });

  it('deduplicates successful retries and permits retries after a rejected call', async () => {
    const { agent, deliver } = fixture();
    agent.followup.mockImplementationOnce(() => {
      throw new Error('not sent');
    });
    await expect(deliver('session-a', intent('followup'))).rejects.toThrow('not sent');
    await deliver('session-a', intent('followup'));
    await deliver('session-a', intent('followup'));
    expect(agent.followup).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown outcome if acceptance cannot be checked after a throw', async () => {
    const agent = {
      inject: vi.fn(),
      followup: vi.fn(() => {
        throw new Error('after acceptance');
      }),
      send: vi.fn(),
    };
    const accepted = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('projection unavailable'));
    const deliver = createDelivery(
      () => agent,
      () => true,
      accepted,
    );
    await expect(deliver('session-a', intent('followup'))).rejects.toMatchObject({ kind: 'unknown' });
    expect(agent.followup).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls with the same delivery id', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = { inject: vi.fn(), followup: vi.fn(), send: vi.fn() };
    const deliver = createDelivery(
      () => agent,
      () => true,
      async () => {
        await barrier;
        return false;
      },
    );
    const first = deliver('session-a', intent('followup'));
    const second = deliver('session-a', intent('followup'));
    release();
    await Promise.all([first, second]);
    expect(agent.followup).toHaveBeenCalledTimes(1);
  });

  it('omits window events and their notes when titles are disabled', async () => {
    const agent = { inject: vi.fn(), followup: vi.fn(), send: vi.fn() };
    const deliver = createDelivery(
      () => agent,
      () => false,
      async () => false,
    );
    const windowUpdate: EnvUpdate = {
      ...update,
      changes: [
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'window',
            kind: 'window.focused',
            at: update.at,
            source: { id: 'test', api: 'fixture', host: 'local' },
            subject: 'fixture',
            data: { title: 'synthetic title' },
          },
          note: 'synthetic title',
        },
      ],
    };
    await deliver('session-a', { ...intent('inject'), update: windowUpdate });
    expect(JSON.stringify(await deliver.messages('session-a'))).not.toContain('synthetic title');
  });

  it.each(['inject', 'followup', 'send'] as const)('projects a consented window title before %s', async (kind) => {
    const { agent, deliver } = fixture();
    const title = 'open </private/fixture/report> ssh user@build-node:22 README.md';
    const windowUpdate: EnvUpdate = {
      ...update,
      changes: [
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'window',
            kind: 'window.focused',
            at: update.at,
            source: { id: 'test', api: 'fixture', host: 'local' },
            subject: 'fixture',
            data: { title },
          },
        },
      ],
    };
    await deliver('session-a', { ...intent(kind), update: windowUpdate });
    const text = JSON.stringify(kind === 'inject' ? await deliver.messages('session-a') : agent[kind].mock.calls);
    expect(text).toContain('&lt;report&gt; ssh &lt;host&gt; README.md');
    expect(text).not.toContain('/private/fixture');
    expect(text).not.toContain('build-node');
  });
});
