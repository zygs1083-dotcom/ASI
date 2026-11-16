import type { EnvUpdate } from '@asi/sense-types';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryIntent } from '../../src/host/attention/pipeline.ts';
import { createDelivery } from '../../src/host/dsh/deliver.ts';

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
          text: '<env-update since="12:01:03" source="asi-sense">\njob: `false` exited 1\n</env-update>',
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

  it('rejects unknown or mismatched sessions rather than broadcasting', async () => {
    const { agent, deliver } = fixture();
    await expect(deliver('other', intent('inject'))).rejects.toThrow();
    expect(agent.inject).not.toHaveBeenCalled();
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
});
