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
  it('includes the job ID for an individual started event', async () => {
    const { agent, deliver } = fixture();
    const change = {
      ...update.changes[0],
      signal: { ...update.changes[0].signal, kind: 'job.started', data: { id: 'synthetic-job' } },
    };
    await deliver('session-a', { ...intent('followup'), update: { ...update, changes: [change] } });
    expect(JSON.stringify(agent.followup.mock.calls)).toContain('job: `synthetic-job` started');
  });

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
    expect(modelTitle('ssh user@build-node:22/tmp/report', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('ssh build-node:22/tmp/report', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('connect 192.0.2.42:22/tmp/report', 'fixture-host')).toBe('connect <host>');
    expect(modelTitle('connect [2001:db8::1]:22/tmp/report', 'fixture-host')).toBe('connect <host>');
  });

  it('projects host-port paths and punctuated app names in delivery', async () => {
    const { agent, deliver } = fixture();
    const changes: EnvUpdate['changes'] = [
      { kind: 'app.activated', data: { name: 'Fixture (Preview)' } },
      { kind: 'window.focused', data: { title: 'ssh build-node:22/tmp/report' } },
    ].map((item, index) => ({
      count: 1,
      level: 'context',
      signal: {
        ...item,
        id: String(index),
        at: update.at,
        subject: 'fixture',
        source: { id: 'fixture', api: 'test', host: 'local' },
      },
    }));
    await deliver('session-a', { ...intent('followup'), update: { ...update, changes } });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('Fixture (Preview)');
    expect(text).toContain('ssh &lt;host&gt;');
    expect(text).not.toContain('build-node');
    expect(text).not.toContain('/tmp/');
  });

  it('uses the bounded application name even if stripping controls leaves it empty', async () => {
    const { agent, deliver } = fixture();
    const change = {
      ...update.changes[0],
      signal: { ...update.changes[0].signal, kind: 'app.activated', data: { name: '\n' } },
    };
    await deliver('session-a', { ...intent('followup'), update: { ...update, changes: [change] } });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('front-app: \\n');
    expect(text).not.toContain('front-app: observation');
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

  it('omits window events and their notes when titles are disabled without delivering an empty envelope', async () => {
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
    await deliver('session-a', { ...intent('inject', 'win-inject'), update: windowUpdate });
    expect(await deliver.messages('session-a')).toEqual([]);
    await deliver('session-a', { ...intent('followup', 'win-followup'), update: windowUpdate });
    await deliver('session-a', { ...intent('send', 'win-send'), update: windowUpdate });
    expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.send).not.toHaveBeenCalled();
  });

  it('whitelists file.changed verbs, rate timeToFloorMs, anomaly sigma and burst deleted counts without path leaks', async () => {
    const { agent, deliver } = fixture();
    const changes: EnvUpdate['changes'] = [
      {
        kind: 'file.changed',
        subject: '/private/dir/new.ts',
        data: { path: '/private/dir/new.ts', change: 'add' },
      },
      {
        kind: 'file.changed',
        subject: '/private/dir/old.ts',
        data: { path: '/private/dir/old.ts', change: 'delete' },
      },
      {
        kind: 'file.changed',
        subject: '/private/dir/moved.ts',
        data: { path: '/private/dir/moved.ts', change: 'rename' },
      },
      {
        kind: 'body.rate',
        subject: 'rate:context-eta',
        data: { metric: 'context', ruleId: 'context-eta', severity: 'warn', slope: -25, timeToFloorMs: 120_000 },
      },
      {
        kind: 'body.anomaly',
        subject: 'baseline:cpu',
        data: { metric: 'cpu', ruleId: 'cpu', severity: 'warn', value: 0.88, baseline: 0.2, deviation: 3.5 },
      },
      {
        kind: 'file.burst',
        subject: '/private/work/project',
        data: {
          directory: '/private/work/project',
          ruleId: 'file.burst',
          windowMs: 60_000,
          created: 2,
          modified: 3,
          deleted: 55,
          agentDeleted: 4,
          externalDeletionExceeded: true,
        },
      },
    ].map((item, index) => ({
      count: 1,
      level: 'context' as const,
      signal: {
        ...item,
        id: `q-${index}`,
        at: update.at + index,
        source: { id: 'fixture', api: 'test', host: 'local' },
      },
    }));
    await deliver('session-a', { ...intent('followup', 'quant'), update: { ...update, changes } });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('file: new.ts created');
    expect(text).toContain('file: old.ts deleted');
    expect(text).toContain('file: moved.ts renamed');
    expect(text).toContain('slope=-25');
    expect(text).toContain('timeToFloorMs=120000');
    expect(text).toContain('deviation=3.5σ');
    expect(text).toContain('file.burst: project');
    expect(text).toContain('created=2');
    expect(text).toContain('modified=3');
    expect(text).toContain('deleted=55');
    expect(text).not.toContain('/private/');
  });

  it('delivers rebaseline suggestions as an explicit model-visible line with redacted metric paths', async () => {
    const { deliver } = fixture();
    const changes: EnvUpdate['changes'] = [
      {
        count: 1,
        level: 'context',
        signal: {
          id: 'rebaseline:1',
          kind: 'body.anomaly',
          at: update.at,
          source: { id: 'body', api: 'probe', host: 'local' },
          subject: 'rebaseline:cpu',
          data: {
            layer: 'baseline',
            severity: 'warn',
            metric: 'cpu',
            type: 'rebaseline-suggestion',
            suggestionId: 'baseline:Y2FuZGlkYXRl:Y3B1:34:0',
            feedbackAvailable: false,
          },
        },
      },
      {
        count: 1,
        level: 'context',
        signal: {
          id: 'rebaseline:2',
          kind: 'body.anomaly',
          at: update.at + 1,
          source: { id: 'body', api: 'probe', host: 'local' },
          subject: 'rebaseline:disk:/private/mount/Data',
          data: {
            layer: 'baseline',
            severity: 'warn',
            metric: 'disk:/private/mount/Data',
            type: 'rebaseline-suggestion',
            suggestionId: 'baseline:Y2FuZGlkYXRl:ZGlzaw:34:0',
            feedbackAvailable: false,
          },
        },
      },
    ];
    await deliver('session-a', { ...intent('inject', 'rebaseline-ctx'), update: { ...update, changes } });
    const messages = await deliver.messages('session-a');
    expect(messages).toHaveLength(1);
    const text = JSON.stringify(messages);
    expect(text).toContain('建议重新基线：cpu');
    expect(text).toContain('建议重新基线：disk:Data');
    expect(text).not.toContain('body.anomaly:');
    expect(text).not.toContain('/private/');
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

  it.each(['inject', 'followup', 'send'] as const)('redacts Unicode hosts before %s', async (kind) => {
    const { agent, deliver } = fixture();
    const changes = ['ssh user@服务器:22/tmp/report', 'ssh 服务器:22/tmp/report'].map((title, index) => ({
      count: 1,
      level: 'context' as const,
      signal: {
        id: `window-${index}`,
        kind: 'window.focused',
        at: update.at,
        source: { id: 'test', api: 'fixture', host: 'local' },
        subject: 'fixture',
        data: { title },
      },
    }));
    await deliver('session-a', { ...intent(kind), update: { ...update, changes } });
    const text = JSON.stringify(kind === 'inject' ? await deliver.messages('session-a') : agent[kind].mock.calls);
    expect(text.match(/ssh &lt;host&gt;/g)).toHaveLength(2);
    expect(text).not.toContain('服务器');
    expect(text).not.toContain('/tmp/');
  });

  it('requires string file.changed change values and safely falls back for non-string or blank file.burst directories', async () => {
    const { agent, deliver } = fixture();
    const changes: EnvUpdate['changes'] = [
      {
        kind: 'file.changed',
        subject: '/synthetic/dir/array-change.ts',
        data: { path: '/synthetic/dir/array-change.ts', change: ['add'] },
      },
      {
        kind: 'file.burst',
        subject: '/synthetic/work/fallback-dir',
        data: { directory: ['/synthetic/private'], deleted: 12 },
      },
      {
        kind: 'file.burst',
        subject: '/synthetic/work/blank-dir',
        data: { directory: '   ', deleted: 8 },
      },
    ].map((item, index) => ({
      count: 1,
      level: 'context' as const,
      signal: {
        ...item,
        id: `edge-${index}`,
        at: update.at + index,
        source: { id: 'fixture', api: 'test', host: 'local' },
      },
    }));
    await deliver('session-a', { ...intent('followup', 'edge-check'), update: { ...update, changes } });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('file: array-change.ts saved');
    expect(text).not.toContain('array-change.ts created');
    expect(text).toContain('file.burst: fallback-dir deleted=12');
    expect(text).toContain('file.burst: blank-dir deleted=8');
    expect(text).not.toContain('/synthetic/');
  });

  it('sanitizes file.activity directory and file names through modelPath', async () => {
    const { agent, deliver } = fixture();
    await deliver('session-a', {
      ...intent('followup', 'file-activity-sanitized'),
      update: {
        ...update,
        changes: [
          {
            count: 1,
            level: 'record',
            signal: {
              id: 'fa-sec',
              kind: 'file.activity',
              at: update.at,
              source: { id: 'files-global', api: 'watch', host: 'local' },
              subject: '/private/secret-user/workspace/src',
              data: {
                directory: '/private/secret-user/workspace/src',
                windowMs: 10_000,
                created: 1,
                modified: 2,
                deleted: 0,
                files: ['/private/secret-user/workspace/src/app.ts', 'readme.md'],
              },
            },
          },
        ],
      },
    });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('file.activity: src');
    expect(text).toContain('files=[app.ts, readme.md]');
    expect(text).not.toContain('/private/');
    expect(text).not.toContain('secret-user');
  });

  it('redacts file.activity emails, ips, usernames, overlong names, and empty token fallbacks without clearing files', async () => {
    const { agent, deliver } = fixture();
    const longName = `${'A'.repeat(600)}.log`;
    await deliver('session-a', {
      ...intent('followup', 'file-activity-privacy'),
      update: {
        ...update,
        changes: [
          {
            count: 1,
            level: 'record',
            signal: {
              id: 'fa-priv',
              kind: 'file.activity',
              at: update.at,
              source: { id: 'files-global', api: 'watch', host: 'local' },
              subject: '/Users/alice',
              data: {
                directory: '/Users/alice',
                windowMs: 10_000,
                created: 1,
                modified: 2,
                deleted: 1,
                rolledUp: 4,
                files: [
                  '/Users/alice/alice@example.com-dump.log',
                  '192.168.10.20.log',
                  longName,
                  'mailto:bob@example.com',
                  '/   ',
                ],
              },
            },
          },
          {
            count: 1,
            level: 'record',
            signal: {
              id: 'fa-home2',
              kind: 'file.activity',
              at: update.at + 1,
              source: { id: 'files-global', api: 'watch', host: 'local' },
              subject: '/home/bob-dev',
              data: {
                directory: '/home/bob-dev',
                windowMs: 10_000,
                created: 1,
                modified: 0,
                deleted: 0,
                files: ['fe80::1ff:fe23:4567:890a.log'],
              },
            },
          },
        ],
      },
    });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('file.activity: ~ windowMs=10000');
    expect(text).toContain('rolledUp=4');
    expect(text).toContain('[file]');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('bob-dev');
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain('bob@example.com');
    expect(text).not.toContain('192.168.10.20');
    expect(text).not.toContain('fe80::1ff:fe23:4567:890a');
    expect(text).not.toContain('files=[]');
    expect(text).toContain('AAAAAAAAAA');
  });
});
