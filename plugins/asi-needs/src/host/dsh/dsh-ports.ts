import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { JobId } from '@deepseek-ai/dsh-jobs';
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { CryDeliveryMode } from '../cry.js';
import type { NeedsHostPorts } from '../ports.js';
import type { CompactionPort, JobsPort, ManagedJobInfo } from '../sandbox.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'asi-needs': { kind: 'asi-needs' };
  }
}

export function createDshNeedsPorts(ctx: Context, storageRoot: string): NeedsHostPorts {
  const resolveAgent = (id: string): Agent | undefined => ctx.agents.get(SessionId(id));

  const jobs: JobsPort = {
    listActiveJobs(): ManagedJobInfo[] {
      try {
        const sessionIds = new Set([
          ...ctx.agents.list().map((a) => a.id),
          ...(ctx.sessions?.list() ?? []).map((s) => s.id),
        ]);
        const all = [ctx.jobs.list(), ...[...sessionIds].map((id) => ctx.jobs.list(id))].flat();
        const deduped = [...new Map(all.map((j) => [j.id, j])).values()];
        return deduped
          .filter((j) => j.status === 'running' || j.status === 'stopping')
          .map((j) => ({
            id: j.id,
            ...(j.owner ? { owner: j.owner } : {}),
            ...(j.label ? { label: j.label } : {}),
            status: j.status,
            startedAt: j.startedAt,
          }));
      } catch {
        return [];
      }
    },

    hasLiveOwner(sessionId: string): boolean {
      if (resolveAgent(sessionId)) return true;
      return Boolean(ctx.sessions?.list().some((s) => s.id === sessionId));
    },

    killJob(id: string, owner: string | undefined, reason: string) {
      try {
        return ctx.jobs.kill(JobId(id), owner ? SessionId(owner) : undefined, reason);
      } catch {
        return 'already-finished';
      }
    },
  };

  const compaction: CompactionPort = {
    listIdleSessionIds(excludeIds: ReadonlySet<string>): string[] {
      return ctx.agents
        .list()
        .filter((agent) => agent.status === 'idle' && !excludeIds.has(agent.id))
        .map((agent) => agent.id);
    },

    async compactIdleSession(sessionId: string, signal: AbortSignal) {
      const agent = resolveAgent(sessionId);
      if (agent?.status !== 'idle') return { compacted: false };
      const engine = (ctx as Context & { get(name: 'compaction'): CompactionEngine | undefined }).get('compaction');
      if (!engine) return { compacted: false };
      const res = await engine.compactNow(agent, signal);
      if (!res) return { compacted: false };
      return { compacted: true };
    },
  };

  const sessions: NeedsHostPorts['sessions'] = {
    async createMaintenanceSession(requestedId: string, cwd: string, title: string): Promise<string> {
      const sid = SessionId(requestedId);
      const created = await ctx.sessionController.create({ cwd, sessionId: sid });
      const actualId = created.sessionId;
      await ctx.sessionController.rename({ sessionId: actualId, title }).catch(() => undefined);
      const resolved = await ctx.sessionController.resolveAgent(actualId);
      if ('error' in resolved) throw resolved.error;
      return actualId;
    },

    hasSession(sessionId: string): boolean {
      if (resolveAgent(sessionId)) return true;
      return Boolean(ctx.sessions?.list().some((s) => s.id === sessionId));
    },

    async runMaintenanceTurn(sessionId: string, prompt: string, signal: AbortSignal): Promise<void> {
      const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId));
      if ('error' in resolved) throw resolved.error;
      const agent = resolved.agent;
      if (signal.aborted) return;

      const msg = freezeMessage({
        id: MessageId(`asi-needs-maint:${randomUUID()}`),
        role: 'user',
        source: { kind: 'asi-needs' },
        content: [{ type: 'text', text: prompt }],
      });

      const onAbort = () => {
        try {
          agent.cancel({ kind: 'disposed' });
        } catch {
          // Ignore cancellation race
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        agent.followup(msg);
        await agent.whenIdle();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },

    async deliverCryToUserSession(
      targetSessionId: string | undefined,
      excludeSessionIds: ReadonlySet<string>,
      content: string,
      mode: CryDeliveryMode,
    ): Promise<boolean> {
      let agent: Agent | undefined;
      if (targetSessionId && !excludeSessionIds.has(targetSessionId)) {
        agent = resolveAgent(targetSessionId);
        if (!agent) {
          const resolved = await ctx.sessionController.resolveAgent(SessionId(targetSessionId)).catch(() => undefined);
          if (resolved && 'agent' in resolved) agent = resolved.agent;
        }
      }
      if (!agent) {
        agent = ctx.agents.list().find((a) => !excludeSessionIds.has(a.id));
      }
      if (!agent) return false;

      const msg = freezeMessage({
        id: MessageId(`asi-needs-cry:${randomUUID()}`),
        role: 'user',
        source: { kind: 'asi-needs' },
        content: [{ type: 'text', text: content }],
      });

      if (mode === 'parked-offline') {
        agent.send(msg, 'next-turn', false);
      } else {
        agent.followup(msg);
      }
      return true;
    },
  };

  return {
    storageRoot,
    sense: ctx.asiSense,
    jobs,
    compaction,
    sessions,
  };
}
