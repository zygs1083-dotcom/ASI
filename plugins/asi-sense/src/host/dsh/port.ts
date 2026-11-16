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
import type { DshPort, ToolEvent } from '../runtime/ports.ts';
import { createDelivery } from './deliver.ts';
import { mapJobEvent, mapToolEvent } from './events.ts';
import { tokenSnapshot } from './tokens.ts';

const open = promisify(execFile);

export function createDshPort(ctx: Context, sendTitles: () => boolean): DshPort {
  const resolve = (id: string): Agent | undefined => ctx.agents.get(SessionId(id));
  const deliver = createDelivery(resolve, sendTitles);
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
    onAgentEvent(cb) {
      const turns = new Map<string, { turn: number; user: boolean }>();
      const offCreated = ctx.on('agent/created', async ({ agent }) => {
        await cb({ type: 'created', sessionId: agent.id });
        return undefined;
      });
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        turns.delete(agent.id);
        call(cb, { type: 'disposed', sessionId: agent.id });
      });
      const offStep = ctx.on('agent/pre-step', async (payload, next) => {
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
        return next();
      });
      const offStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') call(cb, { type: 'post-step', sessionId: agent.id });
      });
      for (const agent of ctx.agents.list()) call(cb, { type: 'created', sessionId: agent.id });
      return () => {
        offCreated();
        offDisposed();
        offStep();
        offStatus();
        turns.clear();
      };
    },
    onTool(cb) {
      const offPre = ctx.on('tools/pre-execute', async (exec, next) => {
        const event = tool('pre-execute', exec);
        if (event) {
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
        if (event) call(cb, event);
      });
      return () => {
        offPre();
        offResult();
      };
    },
    onJob(cb) {
      return ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event.type === 'output') return;
        const mapped = mapJobEvent(event);
        if (mapped) call(cb, mapped);
      });
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
