import { execFile } from 'node:child_process';
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
import { createDelivery } from './deliver.ts';
import { type ActiveTool, JobEventCorrelator, mapToolEvent } from './events.ts';
import { tokenSnapshot } from './tokens.ts';

const open = promisify(execFile);

export function createDshPort(
  ctx: Context,
  sendTitles: () => boolean,
): DshPort & {
  onDeliveryCommitted(cb: (sessionId: string, id: string) => void): () => void;
} {
  const resolve = (id: string): Agent | undefined => ctx.agents.get(SessionId(id));
  const activeTools = new Map<string, ActiveTool>();
  const committed = new Set<(sessionId: string, id: string) => void>();
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
    onDeliveryCommitted(cb) {
      committed.add(cb);
      return () => committed.delete(cb);
    },
    onAgentEvent(cb) {
      const turns = new Map<string, { turn: number; user: boolean }>();
      let selection = 0;
      let selected: string | undefined;
      const offCreated = ctx.on('agent/created', async ({ agent }) => {
        await cb({ type: 'created', sessionId: agent.id });
        return undefined;
      });
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        if (selected === agent.id) {
          selected = undefined;
          selection++;
        }
        turns.delete(agent.id);
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
        const generation = ++selection;
        selected = payload.agent.id;
        deliver.select(payload.agent.id);
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
          generation !== selection ||
          (decision.messages.length === 0 && (payload.step === 1 || payload.messages.length > 0))
        ) {
          if (generation === selection || selected !== payload.agent.id) deliver.discard(payload.agent.id);
          return decision;
        }
        try {
          const messages = await deliver.messages(payload.agent.id);
          if (payload.signal.aborted || generation !== selection || messages.length === 0) {
            if (generation === selection || selected !== payload.agent.id) deliver.discard(payload.agent.id);
            return decision;
          }
          return { ...decision, messages: [...decision.messages, ...messages] };
        } catch {
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
