import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { EnvUpdate } from '@asi/sense-types';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { isSessionContext } from '../attention/buckets.ts';
import { DeliveryFailure } from '../attention/drain.ts';
import type { DeliveryIntent } from '../attention/pipeline.ts';
import { formatEnvUpdate } from '../delivery/format.ts';
import { modelAppName, modelLabel, modelPath, modelTitle } from './tool-output.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    environment: { kind: 'environment' };
  }
}

const MAX_ACTIVITY_NAME = 512;

function isHomeRoot(raw: string): boolean {
  const clean = raw.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  const home = os.homedir().replaceAll('\\', '/').replace(/\/+$/, '');
  const nfcClean = clean.normalize('NFC');
  const nfcHome = home.normalize('NFC');
  if (
    nfcHome &&
    (process.platform === 'darwin' ? nfcClean.toLowerCase() === nfcHome.toLowerCase() : nfcClean === nfcHome)
  ) {
    return true;
  }
  return /^\/(?:Users|home)\/[^/]+$/i.test(nfcClean);
}

function truncateName(value: string, limit = MAX_ACTIVITY_NAME): string {
  if (value.length <= limit) return value;
  const max = Math.max(0, limit - 3);
  let end = 0;
  for (const ch of value) {
    if (end + ch.length > max) break;
    end += ch.length;
  }
  return `${value.slice(0, end)}...`;
}

export function modelActivityName(raw: string, maskHomeRoot = false): string {
  if (maskHomeRoot && isHomeRoot(raw)) return '~';
  const base = modelPath(raw);
  const masked = modelTitle(truncateName(base));
  return masked.trim() ? masked : '[file]';
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
        const maskedPath = modelActivityName(
          typeof signal.data.path === 'string' && signal.data.path.trim() ? signal.data.path : signal.subject,
          true,
        );
        subject = maskedPath;
        data.path = maskedPath;
        if (
          typeof signal.data.change === 'string' &&
          ['add', 'create', 'created', 'modify', 'save', 'saved', 'delete', 'deleted', 'rename', 'renamed'].includes(
            signal.data.change,
          )
        ) {
          data.change = signal.data.change;
        }
      } else if (signal.kind === 'job.started' || signal.kind === 'job.exited' || signal.kind === 'process.exited') {
        if (typeof signal.data.id === 'string') data.id = modelLabel(signal.data.id);
        if (typeof signal.data.exitCode === 'number') data.exitCode = signal.data.exitCode;
        if (typeof signal.data.durationMs === 'number') data.durationMs = signal.data.durationMs;
        if (typeof signal.data.startedAt === 'number') data.startedAt = signal.data.startedAt;
      } else if (signal.kind === 'body.threshold') {
        subject = metric(signal.subject);
        if (['normal', 'warn', 'critical'].includes(String(signal.data.severity))) data.severity = signal.data.severity;
        if (typeof signal.data.value === 'number' && Number.isFinite(signal.data.value)) data.value = signal.data.value;
      } else if (signal.kind === 'body.rate' || signal.kind === 'body.anomaly' || signal.kind === 'file.burst') {
        const rawMetric =
          signal.data.metric ??
          (signal.kind === 'body.anomaly' && signal.data.type === 'rebaseline-suggestion'
            ? signal.subject.replace(/^(?:rebaseline|baseline):/, '')
            : undefined);
        if (signal.kind === 'file.burst') {
          const maskedDir = modelActivityName(
            typeof signal.data.directory === 'string' && signal.data.directory.trim()
              ? signal.data.directory
              : signal.subject,
            true,
          );
          subject = maskedDir;
          data.directory = maskedDir;
        } else {
          subject = metric(rawMetric);
        }
        if (signal.kind === 'body.anomaly' && signal.data.type === 'rebaseline-suggestion') {
          data.type = 'rebaseline-suggestion';
        }
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
          'timeToFloorMs',
          'windowMs',
          'created',
          'modified',
          'deleted',
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
        if (signal.kind === 'file.burst' && signal.data.rolledUp === true) data.rolledUp = true;
      } else if (signal.kind === 'file.activity') {
        const maskedDir = modelActivityName(
          typeof signal.data.directory === 'string' && signal.data.directory.trim()
            ? signal.data.directory
            : signal.subject,
          true,
        );
        subject = maskedDir;
        data.directory = maskedDir;
        for (const key of ['windowMs', 'created', 'modified', 'deleted', 'rolledUp']) {
          const value = signal.data[key];
          if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
        }
        if (Array.isArray(signal.data.files)) {
          const files = signal.data.files
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .slice(0, 5)
            .map((item) => modelActivityName(item, false));
          if (files.length > 0) data.files = files;
        }
        if (signal.data.degraded === true) data.degraded = true;
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
        'file.activity',
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
  onSkipped?: (sessionId: string, id: string, kind: DeliveryIntent['kind']) => void | Promise<void>,
) {
  type Step = { turn: number; step: number };
  const delivered = new Map<string, Set<string>>();
  const staged = new Map<string, Map<string, { intent: DeliveryIntent; step?: Step; returned: boolean }>>();
  const steps = new Map<string, Step>();
  const inflight = new Map<string, Promise<void>>();
  const render = (intent: DeliveryIntent): string =>
    formatEnvUpdate(modelUpdate(intent.update), {
      includeWindowTitles: sendTitles(),
      includeJobCommands: false,
    });
  const message = (id: string, text: string): UserMessage =>
    freezeMessage({
      id: MessageId(id),
      role: 'user',
      source: { kind: 'environment' },
      content: [
        {
          type: 'text',
          text,
        },
      ],
    });
  const recordFor = (sessionId: string, id: string): void => {
    const ids = delivered.get(sessionId) ?? new Set<string>();
    ids.add(id);
    const oldest = ids.values().next().value;
    if (ids.size > 1024 && oldest !== undefined) ids.delete(oldest);
    delivered.set(sessionId, ids);
  };
  const perform = async (
    sessionId: string,
    intent: DeliveryIntent,
    id: string,
    isCurrent?: () => boolean,
  ): Promise<void> => {
    const agent = getAgent(sessionId);
    if (!agent) throw new Error('delivery session unavailable');
    const previous = delivered.get(sessionId);
    if (previous?.has(id) || (await accepted(sessionId, id))) return;
    if (intent.kind !== 'inject' && isCurrent && !isCurrent()) throw new DeliveryFailure('deferred');
    if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
    if (intent.kind === 'inject') {
      const pending = staged.get(sessionId) ?? new Map();
      if (pending.get(id)?.returned) return;
      pending.set(id, { intent: structuredClone(intent), step: steps.get(sessionId), returned: false });
      staged.set(sessionId, pending);
      return;
    }
    const text = render(intent);
    if (!text) {
      recordFor(sessionId, id);
      await onSkipped?.(sessionId, id, intent.kind);
      return;
    }
    try {
      const input = message(id, text);
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
    recordFor(sessionId, id);
  };
  const deliver = async (sessionId: string, intent: DeliveryIntent, isCurrent?: () => boolean): Promise<void> => {
    if (sessionId !== intent.sessionId) throw new Error('delivery session mismatch');
    const id = `asi-sense:${intent.deliveryId ?? randomUUID()}`;
    const key = JSON.stringify([sessionId, id]);
    const prior = inflight.get(key);
    if (prior) return prior;
    const work = perform(sessionId, intent, id, isCurrent);
    inflight.set(key, work);
    try {
      await work;
    } finally {
      if (inflight.get(key) === work) inflight.delete(key);
    }
  };
  return Object.assign(deliver, {
    async messages(sessionId: string, isActive?: () => boolean): Promise<UserMessage[]> {
      const pending = staged.get(sessionId);
      if (!pending) return [];
      const messages: UserMessage[] = [];
      for (const [id, entry] of pending) {
        const wasAccepted = await accepted(sessionId, id);
        if (isActive && !isActive()) break;
        if (pending.get(id) !== entry) continue;
        if (wasAccepted) pending.delete(id);
        else if (!entry.returned) {
          const text = render(entry.intent);
          if (!text) {
            pending.delete(id);
            recordFor(sessionId, id);
            await onSkipped?.(sessionId, id, entry.intent.kind);
          } else {
            messages.push(message(id, text));
          }
        }
      }
      if (!pending.size && staged.get(sessionId) === pending) staged.delete(sessionId);
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
      steps.delete(sessionId);
    },
    select(sessionId: string | undefined): void {
      for (const [session, pending] of staged) {
        if (session === sessionId) continue;
        for (const [id, entry] of pending) {
          const owned = entry.intent.update.changes.some(
            ({ signal }) => isSessionContext(signal) || (signal.source.id === 'dsh' && signal.kind.startsWith('job.')),
          );
          if (!owned && !entry.returned && (!entry.step || steps.get(session) !== entry.step)) pending.delete(id);
        }
        if (!pending.size) staged.delete(session);
      }
    },
    begin(sessionId: string, step: Step): void {
      steps.set(sessionId, step);
    },
    finish(sessionId: string, step: Step, messages?: UserMessage[]): void {
      const pending = staged.get(sessionId);
      for (const [id, entry] of pending ?? []) {
        if (messages?.some((message) => message.id === id)) {
          entry.step = step;
          entry.returned = true;
        } else if (!messages && entry.step === step) pending?.delete(id);
      }
      if (pending?.size === 0) staged.delete(sessionId);
      if (steps.get(sessionId) === step) steps.delete(sessionId);
    },
    end(sessionId: string, position?: { turn: number; step?: number }): boolean {
      const pending = staged.get(sessionId);
      let discarded = false;
      for (const [id, entry] of pending ?? []) {
        if (
          entry.returned &&
          (!position ||
            (entry.step?.turn === position.turn && (position.step === undefined || entry.step.step === position.step)))
        ) {
          pending?.delete(id);
          discarded = true;
        }
      }
      if (pending?.size === 0) staged.delete(sessionId);
      return discarded;
    },
    protected(sessionId: string, id: string): boolean {
      const entry = staged.get(sessionId)?.get(`asi-sense:${id}`);
      return !!entry && (entry.returned || (!!entry.step && steps.get(sessionId) === entry.step));
    },
  });
}
