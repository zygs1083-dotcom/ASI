import { randomUUID } from 'node:crypto';
import type { EnvUpdate } from '@asi/sense-types';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { DeliveryFailure } from '../attention/drain.ts';
import type { DeliveryIntent } from '../attention/pipeline.ts';
import { formatEnvUpdate } from '../delivery/format.ts';
import { modelAppName, modelLabel, modelPath, modelTitle } from './tool-output.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    environment: { kind: 'environment' };
  }
}

function metric(value: unknown): string {
  if (typeof value !== 'string') return 'body';
  if (value.startsWith('disk:')) return `disk:${modelPath(value.slice(5))}`;
  return [
    'cpu',
    'memory',
    'disk',
    'battery',
    'context',
    'network',
    'network.rx',
    'network.tx',
    'thermal',
    'rss',
  ].includes(value)
    ? value
    : 'body';
}

function modelUpdate(update: EnvUpdate): EnvUpdate {
  return {
    since: update.since,
    at: update.at,
    suppressed: update.suppressed,
    alreadyInjected: update.alreadyInjected,
    changes: update.changes.map(({ signal, count, level, ruleId }) => {
      const data: typeof signal.data = {};
      let subject = 'observation';
      if (typeof signal.data.feedbackAvailable === 'boolean') {
        data.feedbackAvailable = signal.data.feedbackAvailable && /^[\w.:-]+$/.test(signal.id);
      }
      if (signal.kind === 'app.activated') {
        if (typeof signal.data.name === 'string') data.name = modelAppName(signal.data.name);
        if (typeof signal.data.previousName === 'string') data.previousName = modelAppName(signal.data.previousName);
      } else if (signal.kind === 'window.focused' || signal.kind === 'window.title-changed') {
        if (typeof signal.data.title === 'string') data.title = modelTitle(signal.data.title);
      } else if (signal.kind === 'file.changed') {
        data.path = modelPath(typeof signal.data.path === 'string' ? signal.data.path : signal.subject);
      } else if (signal.kind === 'job.exited' || signal.kind === 'process.exited') {
        if (typeof signal.data.id === 'string') data.id = modelLabel(signal.data.id);
        if (typeof signal.data.exitCode === 'number') data.exitCode = signal.data.exitCode;
        if (typeof signal.data.durationMs === 'number') data.durationMs = signal.data.durationMs;
        if (typeof signal.data.startedAt === 'number') data.startedAt = signal.data.startedAt;
      } else if (signal.kind === 'body.threshold') {
        subject = metric(signal.subject);
        if (['normal', 'warn', 'critical'].includes(String(signal.data.severity))) data.severity = signal.data.severity;
        if (typeof signal.data.value === 'number' && Number.isFinite(signal.data.value)) data.value = signal.data.value;
      } else if (signal.kind === 'body.rate' || signal.kind === 'body.anomaly' || signal.kind === 'file.burst') {
        subject =
          signal.kind === 'file.burst'
            ? modelPath(typeof signal.data.directory === 'string' ? signal.data.directory : signal.subject)
            : metric(signal.data.metric);
        const ruleId = signal.data.ruleId;
        if (typeof ruleId === 'string' && (/^[\w-]+$/.test(ruleId) || ruleId === 'file.burst')) data.ruleId = ruleId;
        if (['normal', 'warn', 'critical'].includes(String(signal.data.severity))) data.severity = signal.data.severity;
        for (const key of [
          'value',
          'baseline',
          'deviation',
          'slope',
          'delta',
          'etaToFloorMs',
          'windowMs',
          'created',
          'modified',
          'agentDeleted',
        ]) {
          const value = signal.data[key];
          if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
        }
        const { deleted, agentDeleted } = signal.data;
        if (
          typeof deleted === 'number' &&
          Number.isFinite(deleted) &&
          typeof agentDeleted === 'number' &&
          Number.isFinite(agentDeleted) &&
          agentDeleted >= 0 &&
          deleted >= agentDeleted
        )
          data.externalDeleted = deleted - agentDeleted;
        if (signal.data.externalDeletionExceeded === true) data.externalDeletionExceeded = true;
      }
      const summary = signal.data.jobSummary;
      if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
        const { total, omitted, recent } = summary as Record<string, unknown>;
        if (typeof total === 'number' && typeof omitted === 'number' && Array.isArray(recent)) {
          data.jobSummary = {
            total,
            omitted,
            recent: recent.slice(-20).flatMap((item: unknown) => {
              if (!item || typeof item !== 'object') return [];
              const { id, kind, count, exitCode } = item as Record<string, unknown>;
              if (typeof id !== 'string' || !['job.started', 'job.exited'].includes(String(kind))) return [];
              return [
                {
                  id: modelLabel(id),
                  kind,
                  count: typeof count === 'number' ? count : 1,
                  ...(typeof exitCode === 'number' ? { exitCode } : {}),
                },
              ];
            }),
          };
        }
      }
      const kinds = [
        'app.activated',
        'window.focused',
        'window.title-changed',
        'file.changed',
        'job.exited',
        'job.started',
        'job.failed',
        'process.exited',
        'body.threshold',
        'body.rate',
        'body.anomaly',
        'file.burst',
      ];
      return {
        count,
        level,
        ...(signal.kind === 'body.threshold' &&
        (subject === 'disk' || subject.startsWith('disk:')) &&
        typeof ruleId === 'string' &&
        /^[\w-]+$/.test(ruleId)
          ? { ruleId }
          : {}),
        signal: {
          id: signal.id,
          kind: kinds.includes(signal.kind) ? signal.kind : 'observation',
          at: signal.at,
          source: { id: 'asi-sense', api: 'delivery', host: 'local' },
          subject,
          data,
        },
      };
    }),
  };
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
      content: [
        {
          type: 'text',
          text: formatEnvUpdate(modelUpdate(intent.update), {
            includeWindowTitles: sendTitles(),
            includeJobCommands: false,
          }),
        },
      ],
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
