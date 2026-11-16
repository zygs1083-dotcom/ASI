import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-token-meter';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import type { DshPort, ToolEvent } from '../runtime/ports.ts';
import type { NowReadings } from '../sources/dsh.ts';
import { createDelivery } from './deliver.ts';
import { type ActiveTool, JobEventCorrelator, mapToolEvent } from './events.ts';
import { nowReadings } from './now-facts.ts';
import { sessionCatalog } from './sessions.ts';
import { tokenSnapshot } from './tokens.ts';

const open = promisify(execFile);

export function createDshPort(
  ctx: Context,
  sendTitles: () => boolean,
  mono: () => number = () => performance.now(),
  pinned: () => boolean = () => false,
): DshPort & {
  onDeliveryCommitted(cb: (sessionId: string, id: string) => void): () => void;
  nowReadings(sessionId?: string): NowReadings;
  onNowChanged(cb: () => void): () => void;
} {
  const resolve = (id: string): Agent | undefined => ctx.agents.get(SessionId(id));
  const activeTools = new Map<string, ActiveTool>();
  const executingTools = new Map<string, string>();
  const thinking = new Map<string, { agent: Agent; revision: number; attemptId: string; at: number }>();
  const revisions = new WeakMap<Agent, number>();
  const waiting = new Map<string, { agent: Agent; tokens: Set<symbol> }>();
  let selected: string | undefined;
  const steps = new Map<string, symbol>();
  const committed = new Set<(sessionId: string, id: string) => void>();
  const discarded = new Set<() => void>();
  const jobs = new JobEventCorrelator(activeTools);
  const accepted = ctx.sessionProjections.register({
    key: 'asiSenseDeliveries',
    stateSchema: z.array(z.string()),
    stateVersion: 1,
    init: () => [],
    apply: (ids, event) => {
      const messages =
        event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : [];
      const added = messages.filter(
        (message) => message.source.kind === 'environment' && message.id.startsWith('asi-sense:'),
      );
      return added.length ? [...ids, ...added.map((message) => message.id)] : ids;
    },
  });
  const deliver = createDelivery(resolve, sendTitles, async (id, messageId) => {
    const agent = resolve(id);
    if (!agent) throw new Error('delivery session unavailable');
    return (await accepted).stateOf(agent.session).includes(messageId);
  });
  const warn = () => ctx.logger.warn('asi-sense event delivery failed');
  const call = <T>(cb: (event: T) => Promise<void>, event: T): void => {
    void cb(event).catch(warn);
  };
  const tool = (type: ToolEvent['type'], exec: Readonly<ToolExecution>, result?: unknown) => {
    if (!exec.agent) return undefined;
    return mapToolEvent(
      type,
      {
        sessionId: exec.agent.id,
        toolCallId: exec.callId,
        name: exec.name,
        args: exec.arguments,
        defaultCwd: exec.agent.session.header.cwd,
      },
      result,
    );
  };
  return {
    ...sessionCatalog(ctx),
    selectDeliveryTarget(id) {
      selected = id;
      deliver.select(id);
    },
    isDeliveryProtected: deliver.protected,
    onStepDiscarded(cb) {
      discarded.add(cb);
      return () => discarded.delete(cb);
    },
    nowReadings: (sessionId) =>
      nowReadings(
        ctx,
        sessionId,
        executingTools,
        new Set(
          [...thinking]
            .filter(([id, stream]) => resolve(id) === stream.agent && mono() - stream.at < 30_000)
            .map(([id]) => id),
        ),
        new Set([...waiting].filter(([id, item]) => resolve(id) === item.agent).map(([id]) => id)),
      ),
    onNowChanged(cb) {
      let active = true;
      const notify = () => {
        if (active) cb();
      };
      const offStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') {
          thinking.delete(agent.id);
          waiting.delete(agent.id);
        }
        notify();
      });
      const offInbox = ctx.on('agent/inbox/inserted', notify);
      const offClaim = ctx.on('agent/inbox/claimed', notify);
      const offDiscard = ctx.on('agent/inbox/discarded', notify);
      const offTools = ctx.on('tools/change', notify);
      const offExecute = ctx.on('tools/execute', async (exec, next) => {
        if (!exec.agent) return next();
        const key = `${exec.agent.id}:${exec.callId}`;
        thinking.delete(exec.agent.id);
        executingTools.set(key, exec.agent.id);
        notify();
        try {
          return await next();
        } finally {
          executingTools.delete(key);
          notify();
        }
      });
      const offStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (resolve(agent.id) !== agent) return;
        const current = thinking.get(agent.id);
        if (current && mono() - current.at >= 30_000) thinking.delete(agent.id);
        if (frame.type === 'start') {
          if (agent.status === 'idle') return;
          if (frame.revision <= (revisions.get(agent) ?? 0)) return;
          revisions.set(agent, frame.revision);
          thinking.set(agent.id, { agent, revision: frame.revision, attemptId: frame.attemptId, at: mono() });
        } else if (
          thinking.get(agent.id) === current &&
          current?.agent === agent &&
          current.revision === frame.revision &&
          current.attemptId === frame.attemptId
        ) {
          if (frame.type === 'end') thinking.delete(agent.id);
          else current.at = mono();
        } else return;
        notify();
      });
      const interaction = async (request: { agent?: Agent }, next: () => Promise<unknown>) => {
        if (!request.agent) return next();
        const existing = waiting.get(request.agent.id);
        const requests =
          existing?.agent === request.agent ? existing : { agent: request.agent, tokens: new Set<symbol>() };
        const token = Symbol();
        requests.tokens.add(token);
        waiting.set(request.agent.id, requests);
        notify();
        try {
          return await next();
        } finally {
          requests.tokens.delete(token);
          if (!requests.tokens.size && waiting.get(request.agent.id) === requests) waiting.delete(request.agent.id);
          notify();
        }
      };
      const onInteraction = ctx as unknown as {
        on(name: string, listener: typeof interaction, options: { prepend: boolean; global: boolean }): () => void;
      };
      const offApproval = onInteraction.on('approval/request', interaction, { prepend: true, global: true });
      const offQuestions = onInteraction.on('user-questions/request', interaction, { prepend: true, global: true });
      const offJobs = ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event.type !== 'output') notify();
      });
      return () => {
        active = false;
        offStatus();
        offInbox();
        offClaim();
        offDiscard();
        offTools();
        offExecute();
        offStream();
        offApproval();
        offQuestions();
        offJobs();
        thinking.clear();
        waiting.clear();
        executingTools.clear();
      };
    },
    onDeliveryCommitted(cb) {
      committed.add(cb);
      return () => committed.delete(cb);
    },
    onAgentEvent(cb) {
      const turns = new Map<string, { turn: number; user: boolean }>();
      const offCreated = ctx.on('agent/created', async ({ agent }) => {
        await cb({ type: 'created', sessionId: agent.id });
        return undefined;
      });
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        if (selected === agent.id) {
          selected = undefined;
        }
        steps.delete(agent.id);
        turns.delete(agent.id);
        thinking.delete(agent.id);
        waiting.delete(agent.id);
        deliver.clear(agent.id);
        call(cb, { type: 'disposed', sessionId: agent.id });
      });
      const offSession = ctx.on('session/event', (session, event) => {
        if (event.type === 'user/message' && event.data.source.kind === 'environment') {
          deliver.acknowledge(session.id, event.data.id);
          if (event.data.id.startsWith('asi-sense:')) {
            for (const listener of committed) listener(session.id, event.data.id);
          }
        }
      });
      const offStep = ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject' || payload.signal.aborted) return decision;
        const step = Symbol();
        steps.set(payload.agent.id, step);
        deliver.begin(payload.agent.id, step);
        selected = payload.agent.id;
        if (!pinned()) deliver.select(payload.agent.id);
        const prior = turns.get(payload.agent.id);
        const user =
          prior?.turn === payload.turn
            ? prior.user || payload.messages.some((message) => message.source.kind === 'user')
            : payload.messages.some((message) => message.source.kind === 'user');
        turns.set(payload.agent.id, { turn: payload.turn, user });
        try {
          await cb({ type: 'pre-step', sessionId: payload.agent.id, userInitiated: user });
        } catch {
          warn();
        }
        if (
          payload.signal.aborted ||
          steps.get(payload.agent.id) !== step ||
          (decision.messages.length === 0 && (payload.step === 1 || payload.messages.length > 0))
        ) {
          deliver.finish(payload.agent.id, step);
          for (const listener of discarded) listener();
          return decision;
        }
        try {
          const messages = await deliver.messages(payload.agent.id);
          if (payload.signal.aborted || steps.get(payload.agent.id) !== step || messages.length === 0) {
            deliver.finish(payload.agent.id, step);
            for (const listener of discarded) listener();
            return decision;
          }
          deliver.finish(payload.agent.id, step, messages);
          return { ...decision, messages: [...decision.messages, ...messages] };
        } catch {
          deliver.finish(payload.agent.id, step);
          for (const listener of discarded) listener();
          warn();
          return decision;
        }
      });
      const offStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') call(cb, { type: 'post-step', sessionId: agent.id });
      });
      for (const agent of ctx.agents.list()) call(cb, { type: 'created', sessionId: agent.id });
      return () => {
        offCreated();
        offDisposed();
        offSession();
        offStep();
        offStatus();
        turns.clear();
        steps.clear();
      };
    },
    onTool(cb) {
      const offPre = ctx.on('tools/pre-execute', async (exec, next) => {
        const event = tool('pre-execute', exec);
        if (event) {
          const args = exec.arguments;
          activeTools.set(`${event.sessionId}:${event.toolCallId}`, {
            sessionId: event.sessionId,
            name: exec.name,
            cwd: event.cwd,
            command: event.command,
            ...(typeof args === 'object' && args !== null && 'id' in args && typeof args.id === 'string'
              ? { jobId: args.id }
              : {}),
            ...(typeof args === 'object' && args !== null && 'wait' in args && args.wait === true
              ? { waitsForJob: true }
              : {}),
          });
          try {
            await cb(event);
          } catch {
            warn();
          }
        }
        return next();
      });
      const offResult = ctx.on('tools/result', (exec, result) => {
        const event = tool('post-execute', exec, result.value);
        if (event) {
          activeTools.delete(`${event.sessionId}:${event.toolCallId}`);
          call(cb, event);
        }
      });
      return () => {
        offPre();
        offResult();
        activeTools.clear();
      };
    },
    onJob(cb) {
      const off = ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event.type === 'output') return;
        const mapped = jobs.map(event);
        if (mapped) call(cb, mapped);
      });
      return () => {
        off();
        jobs.clear();
      };
    },
    deliver,
    modelJobs(sessionId) {
      if (!resolve(sessionId)) return [];
      return ctx.jobs
        .list(SessionId(sessionId))
        .filter((job) => job.owner === sessionId && (job.status === 'running' || job.status === 'stopping'))
        .map((job) => ({ id: job.id, startedAt: job.startedAt, status: 'running' as const }));
    },
    async tokenSnapshot(sessionId) {
      const agent = resolve(sessionId);
      if (!agent) return undefined;
      const pressure = ctx.tokenMeter.contextPressure(agent.session);
      const projections = ctx.sessionProjections.snapshot(agent.session, ['contextPressure', 'tokenUsage']).values;
      const usage = projections.tokenUsage;
      if (!usage) return undefined;
      const route = agent.model.current();
      const model = route
        ? await ctx.llm.resolveModelInfo(route.provider, route.model).catch(() => undefined)
        : undefined;
      return tokenSnapshot(
        {
          ...projections.contextPressure,
          ...pressure,
          ...(pressure.contextWindow === undefined && model?.context
            ? { contextWindow: model.context.contextWindow }
            : {}),
        },
        usage,
      );
    },
    async openPermissionSettings() {
      if (process.platform === 'darwin') {
        await open('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
      }
    },
  };
}
