import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { DeliveryFailure } from '../attention/drain.ts';
import type { DeliveryIntent } from '../attention/pipeline.ts';
import { formatEnvUpdate } from '../delivery/format.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    environment: { kind: 'environment' };
  }
}

export function createDelivery(
  getAgent: (sessionId: string) => Pick<Agent, 'inject' | 'followup' | 'send'> | undefined,
  sendTitles: () => boolean,
  accepted: (sessionId: string, id: string) => Promise<boolean>,
) {
  const delivered = new Map<string, Set<string>>();
  const staged = new Map<string, Map<string, DeliveryIntent>>();
  const inflight = new Map<string, Promise<void>>();
  const message = (id: string, intent: DeliveryIntent): UserMessage =>
    freezeMessage({
      id: MessageId(id),
      role: 'user',
      source: { kind: 'environment' },
      content: [{ type: 'text', text: formatEnvUpdate(intent.update, { includeWindowTitles: sendTitles() }) }],
    });
  const perform = async (sessionId: string, intent: DeliveryIntent, id: string): Promise<void> => {
    const agent = getAgent(sessionId);
    if (!agent) throw new Error('delivery session unavailable');
    const previous = delivered.get(sessionId);
    if (previous?.has(id) || (await accepted(sessionId, id))) return;
    if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
    if (intent.kind === 'inject') {
      const pending = staged.get(sessionId) ?? new Map<string, DeliveryIntent>();
      pending.set(id, structuredClone(intent));
      staged.set(sessionId, pending);
      return;
    }
    const record = () => {
      const ids = previous ?? new Set<string>();
      ids.add(id);
      const oldest = ids.values().next().value;
      if (ids.size > 1024 && oldest !== undefined) ids.delete(oldest);
      delivered.set(sessionId, ids);
    };
    try {
      const input = message(id, intent);
      if (intent.kind === 'send') agent.send(input, intent.target, intent.wakeup);
      else agent.followup(input);
    } catch (error) {
      let wasAccepted: boolean;
      try {
        if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
        wasAccepted = await accepted(sessionId, id);
        if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
      } catch {
        throw new DeliveryFailure('unknown', 0, error);
      }
      if (!wasAccepted) throw error;
    }
    record();
  };
  const deliver = async (sessionId: string, intent: DeliveryIntent): Promise<void> => {
    if (sessionId !== intent.sessionId) throw new Error('delivery session mismatch');
    const id = `asi-sense:${intent.deliveryId ?? randomUUID()}`;
    const key = JSON.stringify([sessionId, id]);
    const prior = inflight.get(key);
    if (prior) return prior;
    const work = perform(sessionId, intent, id);
    inflight.set(key, work);
    try {
      await work;
    } finally {
      if (inflight.get(key) === work) inflight.delete(key);
    }
  };
  return Object.assign(deliver, {
    async messages(sessionId: string): Promise<UserMessage[]> {
      const pending = staged.get(sessionId);
      if (!pending) return [];
      const messages: UserMessage[] = [];
      for (const [id, intent] of pending) {
        if (await accepted(sessionId, id)) pending.delete(id);
        else messages.push(message(id, intent));
      }
      if (!pending.size) staged.delete(sessionId);
      return messages;
    },
    acknowledge(sessionId: string, id: string): void {
      const pending = staged.get(sessionId);
      pending?.delete(id);
      if (pending?.size === 0) staged.delete(sessionId);
    },
    clear(sessionId: string): void {
      staged.delete(sessionId);
      delivered.delete(sessionId);
    },
    select(sessionId: string): void {
      for (const id of staged.keys()) if (id !== sessionId) staged.delete(id);
    },
    discard(sessionId: string): void {
      staged.delete(sessionId);
    },
  });
}
