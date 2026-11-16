import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
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
): (sessionId: string, intent: DeliveryIntent) => Promise<void> {
  const delivered = new Map<string, Set<string>>();
  return async (sessionId, intent) => {
    if (sessionId !== intent.sessionId) throw new Error('delivery session mismatch');
    const agent = getAgent(sessionId);
    if (!agent) throw new Error('delivery session unavailable');
    const previous = delivered.get(sessionId);
    if (intent.deliveryId && previous?.has(intent.deliveryId)) return;
    const message = createUserMessage({
      source: { kind: 'environment' },
      content: [{ type: 'text', text: formatEnvUpdate(intent.update, { includeWindowTitles: sendTitles() }) }],
    });
    if (intent.kind === 'send') agent.send(message, intent.target, intent.wakeup);
    else agent[intent.kind](message);
    if (intent.deliveryId) {
      const ids = previous ?? new Set<string>();
      ids.add(intent.deliveryId);
      const oldest = ids.values().next().value;
      if (ids.size > 1024 && oldest !== undefined) ids.delete(oldest);
      delivered.set(sessionId, ids);
    }
  };
}
