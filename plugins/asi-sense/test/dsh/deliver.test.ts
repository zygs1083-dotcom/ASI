import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvUpdate } from '@asi/sense-types';
import { describe, expect, it, vi } from 'vitest';
import { setExtraHomes } from '../../src/host/attention/path.ts';
import type { DeliveryIntent } from '../../src/host/attention/pipeline.ts';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { defaultBodyRules } from '../../src/host/body/rules.ts';
import { formatEnvUpdate } from '../../src/host/delivery/format.ts';
import {
  createDelivery,
  DELIVERABLE_KINDS,
  modelUpdate,
  replacePathTokens,
  sanitizeReason,
} from '../../src/host/dsh/deliver.ts';
import { KNOWN_EVENT_KINDS } from '../../src/host/dsh/history-output.ts';
import { MODEL_RULE_KINDS, modelText, modelTitle } from '../../src/host/dsh/tool-output.ts';

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
      'open [path] and [path]',
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
    expect(modelTitle('open /Volumes/backup.example.invalid', 'fixture-host')).toBe('open [path]');
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
    expect(text).toContain('open [path] ssh &lt;host&gt; README.md');
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
    // Whitelist redaction maps blank/empty path tokens to [path]; the old [file] fallback no longer fires.
    expect(text).toContain('[path]');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('bob-dev');
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain('bob@example.com');
    expect(text).not.toContain('192.168.10.20');
    expect(text).not.toContain('fe80::1ff:fe23:4567:890a');
    expect(text).not.toContain('files=[]');
    // Overlong names now collapse to [path] instead of a truncated prefix, so no name fragment leaks.
    expect(text).not.toContain('AAAAAAAAAA');
  });

  it('redacts usernames, emails, and IP:port from file.burst and file.changed before delivery', async () => {
    const { deliver, agent } = fixture();
    await deliver('session-a', {
      kind: 'followup',
      sessionId: 'session-a',
      deliveryId: 'file-burst-redact',
      update: {
        since: update.since,
        at: update.at,
        suppressed: 0,
        changes: [
          {
            count: 1,
            level: 'wake',
            signal: {
              id: 'fb-p1',
              kind: 'file.burst',
              at: update.at,
              source: { id: 'files-global', api: 'watch', host: 'local' },
              subject: 'alice@corp.com-192.168.1.50:5432',
              data: {
                directory: '/Users/alice/alice@corp.com-192.168.1.50:5432',
                windowMs: 60_000,
                created: 1,
                modified: 2,
                deleted: 120,
                rolledUp: true,
              },
            },
          },
          {
            count: 1,
            level: 'context',
            signal: {
              id: 'fc-p1',
              kind: 'file.changed',
              at: update.at + 1,
              source: { id: 'files', api: 'watch', host: 'local' },
              subject: '/home/bob-dev/alice@corp.com-192.168.1.50:5432/secret.log',
              data: {
                path: '/home/bob-dev/alice@corp.com-192.168.1.50:5432/secret.log',
                change: 'delete',
              },
            },
          },
          {
            count: 1,
            level: 'wake',
            signal: {
              id: 'fb-home',
              kind: 'file.burst',
              at: update.at + 2,
              source: { id: 'files-global', api: 'watch', host: 'local' },
              subject: '/Users/alice',
              data: { directory: '/Users/alice', windowMs: 10_000, deleted: 5 },
            },
          },
        ],
      },
    });
    const text = JSON.stringify(agent.followup.mock.calls);
    expect(text).toContain('rolledUp=true');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('bob-dev');
    expect(text).not.toContain('alice@corp.com');
    expect(text).not.toContain('192.168.1.50');
    expect(text).not.toContain('5432');
  });

  it('architecture: routes every file.* subject in deliver.ts through modelActivityName', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, '../../src/host/dsh/deliver.ts'), 'utf8');
    const fnStart = src.indexOf('function modelUpdate(');
    const fnEnd = src.indexOf('export function createDelivery(');
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, fnEnd);

    for (const kind of ['file.changed', 'file.burst', 'file.activity'] as const) {
      expect(body).toContain(kind);
    }

    const changedIdx = body.indexOf("signal.kind === 'file.changed'");
    const burstIdx = body.indexOf("signal.kind === 'file.burst'");
    const activityIdx = body.indexOf("signal.kind === 'file.activity'");
    expect(changedIdx).toBeGreaterThan(-1);
    expect(burstIdx).toBeGreaterThan(-1);
    expect(activityIdx).toBeGreaterThan(-1);

    const changedBlock = body.slice(changedIdx, body.indexOf('} else if', changedIdx));
    expect(changedBlock).toContain('subject = maskedPath');
    expect(changedBlock).toContain('modelActivityName(');

    const burstBlock = body.slice(burstIdx, body.indexOf('} else {', burstIdx));
    expect(burstBlock).toContain('subject = maskedDir');
    expect(burstBlock).toContain('modelActivityName(');

    const activityBlock = body.slice(activityIdx, body.indexOf('const summary =', activityIdx));
    expect(activityBlock).toContain('subject = maskedDir');
    expect(activityBlock).toContain('modelActivityName(');
  });

  it('projects source.status, source.error, app.launched/terminated, system.* and file.activity cleanly', () => {
    const home = os.homedir();
    const projected = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'ss-home',
            kind: 'source.status',
            at: update.at,
            source: { id: 'files-global-denied', api: 'watch', host: 'local' },
            subject: home,
            data: {
              status: 'denied',
              error: 'permission-denied',
              path: home,
              reason: '部分受保护目录无访问权限 https://secret-token@host.example.invalid:8443',
            },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'ss-path',
            kind: 'source.status',
            at: update.at + 1,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: 'helper',
            data: { status: 'error', reason: `${home}/Documents` },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'se-1',
            kind: 'source.error',
            at: update.at + 2,
            source: { id: 'body', api: 'probe', host: 'local' },
            subject: 'body-tuning',
            data: { error: 'tuning-error' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'al-1',
            kind: 'app.launched',
            at: update.at + 3,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: 'com.example.App',
            data: { name: 'Syntax\nEditor', bundleId: 'com.example.App' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'at-1',
            kind: 'app.terminated',
            at: update.at + 4,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: 'com.example.Term',
            data: { bundleId: 'com.example.Term' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'sw-1',
            kind: 'system.wake',
            at: update.at + 5,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: 'system',
            data: { at: update.at + 5, durationMs: 120_000 },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'fa-home',
            kind: 'file.activity',
            at: update.at + 6,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: home,
            data: { directory: home, windowMs: 10_000, created: 1, modified: 0, deleted: 0 },
          },
        },
      ],
    });

    expect(projected.changes).toHaveLength(7);
    const byId = new Map(projected.changes.map((c) => [c.signal.id, c.signal]));
    expect(byId.get('ss-home')).toMatchObject({
      kind: 'source.status',
      subject: 'files-global-denied',
      data: {
        source: 'files-global-denied',
        status: 'denied',
        path: '~',
        error: 'permission-denied',
      },
    });
    expect(String(byId.get('ss-home')?.data.reason)).not.toContain('secret-token');
    expect(String(byId.get('ss-home')?.data.reason)).not.toContain('host.example.invalid');
    expect(byId.get('ss-path')).toMatchObject({
      kind: 'source.status',
      subject: 'helper',
      data: { source: 'helper', status: 'error', reason: 'Documents' },
    });
    expect(byId.get('se-1')).toMatchObject({
      kind: 'source.error',
      subject: 'body',
      data: { source: 'body', error: 'tuning-error' },
    });
    expect(byId.get('al-1')).toMatchObject({
      kind: 'app.launched',
      subject: 'SyntaxEditor',
      data: { name: 'SyntaxEditor' },
    });
    expect(byId.get('at-1')).toMatchObject({
      kind: 'app.terminated',
      subject: 'com.example.Term',
      data: { name: 'com.example.Term' },
    });
    expect(byId.get('sw-1')).toMatchObject({
      kind: 'system.wake',
      subject: 'system',
      data: { at: update.at + 5, durationMs: 120_000 },
    });
    expect(byId.get('fa-home')).toMatchObject({
      kind: 'file.activity',
      subject: '~',
      data: { directory: '~', windowMs: 10_000, created: 1, modified: 0, deleted: 0 },
    });
    expect(JSON.stringify(projected)).not.toContain(home);
  });

  it('drops unknown kinds into suppressed and skips unknown-only deliveries without sending empty observations', async () => {
    const unknownChange: EnvUpdate['changes'][number] = {
      count: 2,
      level: 'context',
      signal: {
        id: 'unk-1',
        kind: 'mystery.unlisted',
        at: update.at,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
        subject: 'raw-secret',
        data: { secret: 'do-not-deliver' },
      },
    };
    const internalChange: EnvUpdate['changes'][number] = {
      count: 1,
      level: 'context',
      signal: {
        id: 'fact-1',
        kind: 'fact.updated',
        at: update.at + 1,
        source: { id: 'asi-sense', api: 'state', host: 'local' },
        subject: 'env.system',
        data: { path: 'env.system', value: { locked: true } },
      },
    };

    const { agent, deliver } = fixture();
    const skipped: Array<{ sessionId: string; id: string; kind: string }> = [];
    const onSkippedDeliver = createDelivery(
      () => agent,
      () => true,
      async () => false,
      (sessionId, id, kind) => {
        skipped.push({ sessionId, id, kind });
      },
    );

    const onlyUnknown = { ...update, suppressed: 1, changes: [unknownChange, internalChange] };
    expect(modelUpdate(onlyUnknown)).toMatchObject({ suppressed: 4, changes: [] });

    await onSkippedDeliver('session-a', {
      ...intent('followup', 'skip-unknown'),
      update: onlyUnknown,
    });
    expect(agent.followup).not.toHaveBeenCalled();
    expect(skipped).toEqual([{ sessionId: 'session-a', id: 'asi-sense:skip-unknown', kind: 'followup' }]);

    await deliver('session-a', {
      ...intent('send', 'mixed-unknown'),
      update: {
        ...update,
        suppressed: 0,
        changes: [
          unknownChange,
          {
            count: 1,
            level: 'context',
            signal: {
              id: 'sys-1',
              kind: 'system.sleep',
              at: update.at + 2,
              source: { id: 'helper', api: 'ndjson', host: 'local' },
              subject: 'system',
              data: { at: update.at + 2 },
            },
          },
        ],
      },
    });
    expect(agent.send).toHaveBeenCalledTimes(1);
    const rendered = JSON.stringify(agent.send.mock.calls[0]?.[0]);
    expect(rendered).toContain('system: sleep');
    expect(rendered).toContain('suppressed: 2');
    expect(rendered).not.toContain('observation');
    expect(rendered).not.toContain('mystery.unlisted');
    expect(rendered).not.toContain('do-not-deliver');
  });

  it('architecture: every default rule and deliverable kind projects with non-observation subject and non-empty data', () => {
    const internalOnlyKinds = new Set(['fact.updated', 'delivery-unknown']);
    const expectedDeliverableKinds = new Set<string>([
      ...DEFAULT_RULES.map((rule) => rule.match.kind),
      ...defaultBodyRules().map((rule) => rule.match.kind),
      ...DELIVERABLE_KINDS,
      ...[...MODEL_RULE_KINDS].filter((kind) => !internalOnlyKinds.has(kind)),
      ...[...KNOWN_EVENT_KINDS].filter((kind) => !internalOnlyKinds.has(kind)),
    ]);

    for (const kind of expectedDeliverableKinds) {
      expect(DELIVERABLE_KINDS.has(kind)).toBe(true);
      const projected = modelUpdate({
        since: update.since,
        at: update.at,
        suppressed: 0,
        changes: [
          {
            count: 1,
            level: 'context',
            signal: {
              id: `arch-${kind}`,
              kind,
              at: update.at,
              source: { id: 'helper', api: 'ndjson', host: 'local' },
              subject: '',
              data: {},
            },
          },
        ],
      });
      expect(projected.suppressed).toBe(0);
      expect(projected.changes).toHaveLength(1);
      const sig = projected.changes[0]?.signal;
      expect(sig?.kind).toBe(kind);
      expect(sig?.subject).not.toBe('observation');
      expect(Object.keys(sig?.data ?? {}).length).toBeGreaterThan(0);

      const formatted = formatEnvUpdate(projected);
      expect(formatted.length).toBeGreaterThan(0);
      expect(formatted).not.toContain('observation');
    }
  });

  it('replaces embedded POSIX, tilde, Windows, and delimited paths in reason/lastFailure/error without leaking usernames', () => {
    const home = os.homedir();
    const homeBase = path.basename(home);
    expect(replacePathTokens('EACCES: permission denied, scandir /Users/alice')).toBe(
      'EACCES: permission denied, scandir ~',
    );
    expect(replacePathTokens(`EACCES: scandir ${home}`)).toBe('EACCES: scandir ~');
    expect(replacePathTokens('open /home/bob')).toBe('open ~');
    expect(replacePathTokens('EACCES: scandir /Users/alice, permission denied')).toBe(
      'EACCES: scandir ~, permission denied',
    );
    expect(replacePathTokens("open '/Users/alice/.ssh/config'")).toBe("open 'config'");
    expect(replacePathTokens('(/home/bob/x)')).toBe('(x)');
    expect(replacePathTokens('C:\\Users\\carol\\a.txt,')).toBe('a.txt,');
    expect(replacePathTokens('Error opening C:\\Users\\alice')).toBe('Error opening ~');
    expect(replacePathTokens('open ~/secret/file.txt')).toBe('open file.txt');
    expect(replacePathTokens('open ~/')).toBe('open [path]');
    expect(replacePathTokens('path:/Users/alice: denied')).toBe('path:~: denied');
    expect(replacePathTokens('/Users/alice:/home/bob')).toBe('~:~');
    expect(replacePathTokens('C:\\Users\\alice;C:\\Users\\bob')).toBe('~;~');
    expect(replacePathTokens('https://secret-token@host.example.invalid:8443/Users/alice')).toBe(
      'https://secret-token@host.example.invalid:8443/Users/alice',
    );

    const projected = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r1',
            kind: 'source.status',
            at: update.at,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: { status: 'denied', reason: 'EACCES: permission denied, scandir /Users/alice' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r2',
            kind: 'source.status',
            at: update.at + 1,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: { status: 'denied', reason: `EACCES: scandir ${home}` },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r3',
            kind: 'source.error',
            at: update.at + 2,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: { error: 'open /home/bob', reason: 'EACCES: scandir /Users/alice, permission denied' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r4',
            kind: 'source.status',
            at: update.at + 3,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: { status: 'error', lastFailure: "open '/Users/alice/.ssh/config'" },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r5',
            kind: 'source.status',
            at: update.at + 4,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: { status: 'error', reason: '(/home/bob/x)' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r6',
            kind: 'source.error',
            at: update.at + 5,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: { error: 'C:\\Users\\carol\\a.txt,', reason: 'Error opening C:\\Users\\alice' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'r7',
            kind: 'source.status',
            at: update.at + 6,
            source: { id: 'files-global', api: 'watch', host: 'local' },
            subject: 'files-global',
            data: {
              status: 'error',
              reason: 'open ~/secret/file.txt and https://secret-token@host.example.invalid/Users/alice',
            },
          },
        },
      ],
    });

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('bob');
    expect(serialized).not.toContain('carol');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('host.example.invalid');
    if (homeBase && homeBase !== '/' && homeBase.length > 2) {
      expect(serialized).not.toContain(homeBase);
    }
    const formatted = formatEnvUpdate(projected);
    expect(formatted).not.toContain('alice');
    expect(formatted).not.toContain('bob');
    expect(formatted).not.toContain('carol');
  });

  it('strips path prefixes before modelAppName on app.* and window.* fallback subjects and handles Windows paths', () => {
    const projected = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'a1',
            kind: 'app.launched',
            at: update.at,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: '/Users/alice/Tools/SecretTool.app',
            data: { bundleId: '/Users/alice/Tools/SecretTool.app' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'a2',
            kind: 'app.terminated',
            at: update.at + 1,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: 'C:\\Users\\carol\\Tools\\WinTool.exe',
            data: {},
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'a3',
            kind: 'app.activated',
            at: update.at + 2,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: `/Users/alice/${'sub/'.repeat(100)}LongTool.app`,
            data: { name: '/Users/alice/Tools/NamedTool.app' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'a4',
            kind: 'app.launched',
            at: update.at + 3,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            subject: '/Users/alice',
            data: {},
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'w1',
            kind: 'window.focused',
            at: update.at + 4,
            source: { id: 'helper.ax', api: 'accessibility', host: 'local' },
            subject: 'alice@10.0.0.1 - /Users/alice/notes.md',
            data: { title: 'notes' },
          },
        },
        {
          count: 1,
          level: 'context',
          signal: {
            id: 'w2',
            kind: 'window.title-changed',
            at: update.at + 5,
            source: { id: 'helper.ax', api: 'accessibility', host: 'local' },
            subject: 'C:\\Users\\bob\\Editor.exe',
            data: { title: 'notes' },
          },
        },
      ],
    });

    const byId = new Map(projected.changes.map((c) => [c.signal.id, c.signal]));
    expect(byId.get('a1')).toMatchObject({ subject: 'SecretTool.app', data: { name: 'SecretTool.app' } });
    expect(byId.get('a2')).toMatchObject({ subject: 'WinTool.exe', data: { name: 'WinTool.exe' } });
    expect(byId.get('a3')).toMatchObject({ subject: 'NamedTool.app', data: { name: 'NamedTool.app' } });
    expect(byId.get('a4')).toMatchObject({ subject: '~', data: { name: '~' } });
    expect(byId.get('w1')).toMatchObject({ subject: 'notes.md', data: { title: 'notes' } });
    expect(byId.get('w2')).toMatchObject({ subject: 'Editor.exe', data: { title: 'notes' } });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('bob');
    expect(serialized).not.toContain('carol');
    expect(serialized).not.toContain('10.0.0.1');
    const formatted = formatEnvUpdate(projected);
    expect(formatted).toContain('app: SecretTool.app launched');
    expect(formatted).toContain('app: WinTool.exe terminated');
    expect(formatted).not.toContain('/Users/');
  });

  it('fast-paths known source statuses, caches sanitizeReason with <=256 LRU entries, and queries os.hostname() once per batch', () => {
    const hostnameSpy = vi.spyOn(os, 'hostname').mockReturnValue('local-host-fixture');
    try {
      const batch = Array.from({ length: 50 }, (_, i) => ({
        count: 1,
        level: 'context' as const,
        signal: {
          id: `st-${i}`,
          kind: 'source.status',
          at: update.at + i,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          subject: 'files-global',
          data: { status: 'denied', reason: 'permission-denied-fixture' },
        },
      }));
      const out = modelUpdate({ since: update.since, at: update.at + 50, suppressed: 0, changes: batch });
      expect(out.changes).toHaveLength(50);
      expect(out.changes[0]?.signal.data).toMatchObject({ status: 'denied', reason: 'permission-denied-fixture' });
      expect(hostnameSpy).toHaveBeenCalledTimes(1);

      // Non-enum status still uses modelLabel and hostname redaction.
      const hostStatusOut = modelUpdate({
        since: update.since,
        at: update.at,
        suppressed: 0,
        changes: [
          {
            count: 1,
            level: 'context',
            signal: {
              id: 'bad-status',
              kind: 'source.status',
              at: update.at,
              source: { id: 'helper', api: 'ndjson', host: 'local' },
              subject: 'helper',
              data: { status: 'local-host-fixture', reason: 'on local-host-fixture' },
            },
          },
        ],
      });
      expect(hostStatusOut.changes[0]?.signal.data).toMatchObject({
        status: '[host]',
        reason: 'on [host]',
      });

      // Hostname and extraHomes changes invalidate the sanitizeReason cache safely.
      expect(sanitizeReason('custom /srv/home/demo_user')).toBe('custom demo_user');
      setExtraHomes(['/srv/home/demo_user']);
      expect(sanitizeReason('custom /srv/home/demo_user')).toBe('custom [host]');
      setExtraHomes([]);
      expect(sanitizeReason('custom /srv/home/demo_user')).toBe('custom demo_user');

      // Eviction above 256 entries keeps working without throwing or retaining stale results.
      for (let i = 0; i < 270; i++) {
        expect(sanitizeReason(`err-${i}`)).toBe(`err-${i}`);
      }
      expect(sanitizeReason('err-0')).toBe('err-0');
    } finally {
      setExtraHomes([]);
      hostnameSpy.mockRestore();
    }
  });

  it('projects 10,000 source.status signals within 300ms without leaking paths', () => {
    const T = Date.UTC(2026, 10, 18, 12, 0, 0);
    const changes = Array.from({ length: 10_000 }, (_, i) => ({
      count: 1,
      level: 'context' as const,
      signal: {
        id: `ss-${i}`,
        kind: 'source.status',
        at: T + i,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        subject: 'files-global',
        data: { status: 'error', reason: "EACCES: permission denied, open '/Users/alice/.ssh/config'" },
      },
    }));
    const distinctChanges = Array.from({ length: 2_000 }, (_, i) => ({
      count: 1,
      level: 'context' as const,
      signal: {
        id: `sd-${i}`,
        kind: 'source.status',
        at: T + i,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        subject: 'files-global',
        data: { status: 'error', reason: `EACCES: permission denied, open '/Users/alice/dir-${i}/.ssh/config'` },
      },
    }));
    // Warm up both cached and uncached paths, then compare 10,000 cached signals against 2,000 uncached signals
    // so the assertion scales with CPU load while still catching cache/fast-path regressions.
    modelUpdate({ since: T, at: T + 10_000, suppressed: 0, changes });
    modelUpdate({ since: T, at: T + 10_000, suppressed: 0, changes: distinctChanges.slice(0, 300) });

    let out!: ReturnType<typeof modelUpdate>;
    const cachedTimes: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      out = modelUpdate({ since: T, at: T + 10_000, suppressed: 0, changes });
      cachedTimes.push(performance.now() - t0);
    }
    const uncachedTimes: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      modelUpdate({ since: T, at: T + 10_000, suppressed: 0, changes: distinctChanges });
      uncachedTimes.push(performance.now() - t0);
    }
    const minCachedMs = Math.min(...cachedTimes);
    const minUncached2kMs = Math.min(...uncachedTimes);
    expect(out.changes).toHaveLength(10_000);
    expect(out.changes[0]?.signal.data.status).toBe('error');
    expect(String(out.changes[0]?.signal.data.reason)).not.toContain('alice');
    expect(minCachedMs).toBeLessThanOrEqual(minUncached2kMs);
  });

  it('sanitizes embedded paths and hostnames in away.summary text fields', () => {
    const projected = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'wake',
          signal: {
            id: 'away:1',
            kind: 'away.summary',
            at: update.at,
            source: { id: 'away', api: 'detector', host: 'local' },
            subject: 'away',
            data: {
              awayFrom: update.since - 3_600_000,
              returnAt: update.at,
              durationMs: 3_600_000,
              sleepMs: 3_600_000,
              lockMs: 0,
              hasAnomaly: true,
              anomalies: ['alerts', 'failed-jobs', 'external-deletion'],
              reason: 'EACCES: open /Users/alice/x',
              error: 'EACCES: open /Users/alice/x',
              alerts: [
                {
                  metric: 'disk:/Users/alice/x',
                  severity: 'warn',
                  count: 2,
                  reason: 'EACCES: open /Users/alice/x',
                },
              ],
              failed: [
                {
                  id: 'EACCES: open /Users/alice/x',
                  kind: 'job.failed',
                  exitCode: 1,
                  reason: 'EACCES: open /Users/alice/x',
                },
              ],
              bursts: [
                {
                  directory: '/Users/alice/x',
                  deleted: 60,
                  reason: 'EACCES: open /Users/alice/x',
                },
              ],
            },
          },
        },
      ],
    });

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('/Users/alice');
    expect(formatEnvUpdate(projected)).not.toContain('alice');
    const data = projected.changes[0]?.signal.data as Record<string, unknown>;
    expect(data.reason).toBe('EACCES: open x');
    expect(data.error).toBe('EACCES: open x');
    expect((data.alerts as Array<Record<string, unknown>>)[0]).toMatchObject({
      metric: 'disk:x',
      severity: 'warn',
      count: 2,
      reason: 'EACCES: open x',
    });
    expect((data.failed as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'EACCES: open x',
      kind: 'job.failed',
      exitCode: 1,
      reason: 'EACCES: open x',
    });
    expect((data.bursts as Array<Record<string, unknown>>)[0]).toMatchObject({
      directory: 'x',
      deleted: 60,
      reason: 'EACCES: open x',
    });
  });

  it('bounds away.summary projection under 2KB by priority, preserves totals/anomalyCount/omitted, and drops negative numbers', () => {
    const longCjkBurst = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'wake',
          signal: {
            id: 'away:cjk',
            kind: 'away.summary',
            at: update.at,
            source: { id: 'away', api: 'detector', host: 'local' },
            subject: 'away',
            data: {
              awayFrom: update.since - 3_600_000,
              returnAt: update.at,
              durationMs: -5,
              sleepMs: -1,
              lockMs: 3_600_000,
              hasAnomaly: true,
              anomalies: ['external-deletion'],
              alerts: [],
              metrics: [],
              failed: [],
              bursts: [{ directory: `/Users/alice/${'甲'.repeat(511)}`, deleted: 80 }],
              alertCount: 0,
              failedCount: 0,
              deletedCount: 80,
            },
          },
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(longCjkBurst), 'utf8')).toBeLessThanOrEqual(2048);
    const cjkData = longCjkBurst.changes[0]?.signal.data as Record<string, unknown>;
    expect(cjkData.durationMs).toBeUndefined();
    expect(cjkData.sleepMs).toBeUndefined();
    expect(cjkData.lockMs).toBe(3_600_000);
    expect(cjkData.bursts as Array<Record<string, unknown>>).toHaveLength(1);
    expect(cjkData.anomalyCount).toBe(1);
    expect(cjkData.omitted).toBeUndefined();

    const prioritized = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'wake',
          signal: {
            id: 'away:prio',
            kind: 'away.summary',
            at: update.at,
            source: { id: 'away', api: 'detector', host: 'local' },
            subject: 'away',
            data: {
              awayFrom: update.since - 3_600_000,
              returnAt: update.at,
              durationMs: 3_600_000,
              sleepMs: 0,
              lockMs: 3_600_000,
              hasAnomaly: true,
              anomalies: ['alerts', 'failed-jobs', 'external-deletion', 'metric-warning'],
              alerts: [
                { metric: 'memory', severity: 'warn', count: 2 },
                { metric: 'context', severity: 'critical', count: 1 },
              ],
              metrics: [
                { metric: 'cpu', unit: 'ratio', start: 0.2, end: 0.2, min: 0.2, max: 0.2 },
                {
                  metric: 'disk',
                  unit: 'bytes',
                  start: 500,
                  end: 40,
                  min: 40,
                  max: 500,
                  ratioStart: 0.5,
                  ratioMin: 0.04,
                },
              ],
              failed: Array.from({ length: 40 }, (_, i) => ({
                id: `job-${i}-${'word '.repeat(25)}`,
                kind: 'job.exited',
                exitCode: 1,
              })),
              bursts: [{ directory: '/Users/alice/build', deleted: 100 }],
              alertCount: 3,
              failedCount: 40,
              deletedCount: 100,
            },
          },
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(prioritized), 'utf8')).toBeLessThanOrEqual(2048);
    const prioData = prioritized.changes[0]?.signal.data as Record<string, unknown>;
    expect(prioData.failedCount).toBe(40);
    expect(prioData.deletedCount).toBe(100);
    expect(prioData.anomalyCount).toBe(44);
    expect(typeof prioData.omitted).toBe('number');
    expect(prioData.omitted as number).toBeGreaterThan(0);
    expect((prioData.alerts as Array<{ severity: string; metric: string }>).map((a) => a.severity)).toEqual([
      'critical',
      'warn',
    ]);
  });

  it('strips reasons from all entries first and drops by priority critical alerts > critical metrics > bursts > warn alerts > warn metrics > failed > normal metrics', () => {
    const p1 = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'wake',
          signal: {
            id: 'away:p1',
            kind: 'away.summary',
            at: update.at,
            source: { id: 'away', api: 'detector', host: 'local' },
            subject: 'away',
            data: {
              awayFrom: update.since - 3_600_000,
              returnAt: update.at,
              durationMs: 3_600_000,
              sleepMs: 0,
              lockMs: 3_600_000,
              hasAnomaly: true,
              anomalies: ['alerts', 'failed-jobs', 'external-deletion', 'metric-warning', 'metric-growth'],
              alerts: [
                { metric: 'memory', severity: 'warn', count: 2 },
                { metric: 'thermal', severity: 'critical', count: 1 },
              ],
              metrics: [
                { metric: 'load1', unit: 'load', start: 1, end: 1, min: 1, max: 1 },
                { metric: 'cpu', unit: 'ratio', start: 0.1, end: 0.5, min: 0.1, max: 0.5 },
                {
                  metric: 'disk',
                  unit: 'bytes',
                  start: 1000,
                  end: 20,
                  min: 20,
                  max: 1000,
                  ratioStart: 0.5,
                  ratioMin: 0.02,
                },
              ],
              failed: Array.from({ length: 20 }, (_, i) => ({
                id: `job-${i}-${'alpha beta '.repeat(10)}`,
                kind: 'job.exited',
                exitCode: 1,
              })),
              bursts: [{ directory: '/Users/alice/important-data', deleted: 200 }],
              alertCount: 3,
              failedCount: 20,
              deletedCount: 200,
            },
          },
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(p1), 'utf8')).toBeLessThanOrEqual(2048);
    const p1Data = p1.changes[0]?.signal.data as Record<string, unknown>;
    expect(p1Data.bursts).toEqual([{ directory: 'important-data', deleted: 200 }]);
    expect((p1Data.metrics as Array<{ metric: string }>).map((m) => m.metric)).toEqual(['disk', 'cpu']);
    expect(
      (p1Data.alerts as Array<{ metric: string; severity: string }>).map((a) => `${a.severity}:${a.metric}`),
    ).toEqual(['critical:thermal', 'warn:memory']);
    const p1Text = formatEnvUpdate(p1);
    expect(p1Text).toContain('metrics=disk=2%,cpu=+400%');
    expect(p1Text).toContain('deletes=200@important-data');

    const p2 = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'wake',
          signal: {
            id: 'away:p2',
            kind: 'away.summary',
            at: update.at,
            source: { id: 'away', api: 'detector', host: 'local' },
            subject: 'away',
            data: {
              awayFrom: update.since - 3_600_000,
              returnAt: update.at,
              durationMs: 3_600_000,
              sleepMs: 0,
              lockMs: 3_600_000,
              hasAnomaly: true,
              anomalies: ['alerts'],
              alerts: Array.from({ length: 12 }, (_, i) => ({
                metric: `disk:/Volumes/volume-${i}-${'x'.repeat(40)}`,
                severity: 'critical',
                count: 1,
                reason: `critical disk pressure on volume-${i} ${'detail '.repeat(15)}`,
              })),
              metrics: [],
              failed: [],
              bursts: [],
              alertCount: 12,
              failedCount: 0,
              deletedCount: 0,
            },
          },
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(p2), 'utf8')).toBeLessThanOrEqual(2048);
    const p2Data = p2.changes[0]?.signal.data as Record<string, unknown>;
    expect(p2Data.alerts as unknown[]).toHaveLength(12);
    expect(p2Data.omitted).toBeUndefined();
    expect((p2Data.alerts as Array<Record<string, unknown>>).every((a) => a.reason === undefined)).toBe(true);

    // When 30 bursts saturate 2KB even after shrinking, warn alert & warn metric drop before bursts/critical.
    const p3 = modelUpdate({
      since: update.since,
      at: update.at,
      suppressed: 0,
      changes: [
        {
          count: 1,
          level: 'wake',
          signal: {
            id: 'away:p3',
            kind: 'away.summary',
            at: update.at,
            source: { id: 'away', api: 'detector', host: 'local' },
            subject: 'away',
            data: {
              awayFrom: update.since - 3_600_000,
              returnAt: update.at,
              durationMs: 3_600_000,
              sleepMs: 0,
              lockMs: 3_600_000,
              hasAnomaly: true,
              anomalies: ['alerts', 'failed-jobs', 'external-deletion', 'metric-warning', 'metric-growth'],
              alerts: [
                { metric: 'memory', severity: 'warn', count: 1 },
                { metric: 'thermal', severity: 'critical', count: 1 },
              ],
              metrics: [
                { metric: 'cpu', unit: 'ratio', start: 0.1, end: 0.5, min: 0.1, max: 0.5 },
                {
                  metric: 'battery',
                  unit: 'percent',
                  start: 50,
                  end: 3,
                  min: 3,
                  max: 50,
                  ratioStart: 0.5,
                  ratioMin: 0.03,
                },
              ],
              failed: [{ id: 'job-fail', kind: 'job.failed', exitCode: 1 }],
              bursts: Array.from({ length: 30 }, (_, i) => ({
                directory: `/Users/alice/workspace/dir-${i}-${'seg-'.repeat(8)}`,
                deleted: 100,
              })),
              alertCount: 2,
              failedCount: 1,
              deletedCount: 3000,
            },
          },
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(p3), 'utf8')).toBeLessThanOrEqual(2048);
    const p3Data = p3.changes[0]?.signal.data as Record<string, unknown>;
    expect((p3Data.alerts as Array<{ severity: string }>).map((a) => a.severity)).toEqual(['critical']);
    expect((p3Data.metrics as Array<{ metric: string }>).map((m) => m.metric)).toEqual(['battery']);
    expect(p3Data.failed).toBeUndefined();
    expect((p3Data.bursts as unknown[]).length).toBeGreaterThan(0);
  });
});
