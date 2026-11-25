import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { JobId } from '@deepseek-ai/dsh-jobs';
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  ASI_INTERNAL_CWD_RE,
  ASI_INTERNAL_SESSION_ID_RE,
  buildUnifiedExcludedInternalRoots,
  fastSafeRealpath,
  isInsideExcludedRoots,
} from '../../../shared/internal-guards.js';
import type { CryDeliveryMode } from '../cry.js';
import type { NeedsHostPorts } from '../ports.js';
import type { CompactionPort, JobsPort, ManagedJobInfo } from '../sandbox.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'asi-needs': { kind: 'asi-needs' };
  }
}

export function createDshNeedsPorts(ctx: Context, storageRoot: string, options?: { homeDir?: string }): NeedsHostPorts {
  const resolveAgent = (id: string): Agent | undefined => ctx.agents.get(SessionId(id));
  const getWorkspaceRegistry = (): WorkspaceRegistry | undefined =>
    (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get('workspaceRegistry');
  const getSessionController = (): Context['sessionController'] | undefined =>
    (ctx as Context & { get(name: 'sessionController'): Context['sessionController'] | undefined }).get(
      'sessionController',
    );

  const sandboxRoot = resolve(join(storageRoot, 'sandbox'));
  const safeRealpath = fastSafeRealpath;
  const INTERNAL_SESSION_ID_RE = ASI_INTERNAL_SESSION_ID_RE;
  const INTERNAL_SANDBOX_CWD_RE = ASI_INTERNAL_CWD_RE;
  const excludedRoots = [sandboxRoot, ...buildUnifiedExcludedInternalRoots(storageRoot, ctx.asiSense.storageRoot)];

  const isUserOrdinaryAgent = (agent: Agent): boolean => {
    const id = String(agent.id ?? '');
    if (!id || INTERNAL_SESSION_ID_RE.test(id)) return false;
    const header = agent.session?.header;
    if (header?.origin === 'subagent') return false;
    if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return false;
    const cwd = header?.cwd;
    if (typeof cwd === 'string' && cwd.trim()) {
      if (INTERNAL_SANDBOX_CWD_RE.test(cwd)) return false;
      if (isInsideExcludedRoots(cwd, excludedRoots)) return false;
    }
    const wr = getWorkspaceRegistry();
    if (wr?.archivedSessionIds.includes(agent.id)) return false;
    return true;
  };

  const isKnownSession = (sessionId: string): boolean => {
    const sid = SessionId(sessionId);
    const wr = getWorkspaceRegistry();
    if (wr?.archivedSessionIds.includes(sid)) return false;
    if (resolveAgent(sessionId)) return true;
    if (ctx.sessions?.list().some((s) => s.id === sid)) return true;
    return Boolean(wr?.list().some((ws) => ws.sessionIds.includes(sid)));
  };

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
      return isKnownSession(sessionId);
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
        .filter((agent) => agent.status === 'idle' && !excludeIds.has(agent.id) && isUserOrdinaryAgent(agent))
        .map((agent) => agent.id);
    },

    async compactIdleSession(sessionId: string, signal: AbortSignal) {
      const agent = resolveAgent(sessionId);
      if (agent?.status !== 'idle') return { compacted: false };
      const engine = (ctx as Context & { get(name: 'compaction'): CompactionEngine | undefined }).get('compaction');
      if (!engine) return { compacted: false };
      const res = await engine.compactNow(agent, signal);
      if (!res) return { compacted: false };
      return {
        compacted: true,
        ...(typeof res.shadowedTokenCount === 'number' ? { tokensSaved: res.shadowedTokenCount } : {}),
      };
    },
  };

  const sessions: NeedsHostPorts['sessions'] = {
    async createMaintenanceSession(requestedId: string, cwd: string, title: string): Promise<string> {
      const sc = getSessionController();
      if (!sc) {
        throw new Error('sessionController is not available in this DSH profile');
      }
      await mkdir(cwd, { recursive: true });
      const sid = SessionId(requestedId);
      const wr = getWorkspaceRegistry();
      const realCwd = safeRealpath(cwd);
      const existingWs = wr?.list().find((w) => w.path === cwd || safeRealpath(w.path) === realCwd);
      const ws = existingWs ?? (wr ? await wr.create(cwd, title).catch(() => undefined) : undefined);
      const created = await sc.create(ws ? { workspaceId: ws.id, sessionId: sid } : { cwd, sessionId: sid });
      const actualId = created.sessionId;
      await sc.rename({ sessionId: actualId, title }).catch(() => undefined);
      const resolved = await sc.resolveAgent(actualId);
      if ('error' in resolved) throw resolved.error;
      return actualId;
    },

    hasSession(sessionId: string): boolean {
      return isKnownSession(sessionId);
    },

    async runMaintenanceTurn(sessionId: string, prompt: string, signal: AbortSignal): Promise<void> {
      const sc = getSessionController();
      if (!sc) {
        throw new Error('sessionController is not available in this DSH profile');
      }
      const resolved = await sc.resolveAgent(SessionId(sessionId));
      if ('error' in resolved) throw resolved.error;
      const agent = resolved.agent;
      if (signal.aborted) return;

      const msg = freezeMessage({
        id: MessageId(`asi-needs-maint:${randomUUID()}`),
        role: 'user',
        source: { kind: 'asi-needs' },
        content: [{ type: 'text', text: prompt }],
      });

      let turnError: unknown;
      const offError = ctx.on('agent/error', ({ agent: errAgent, error }) => {
        if (errAgent.id === agent.id && turnError === undefined) {
          turnError = error ?? new Error('Maintenance turn failed');
        }
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
        offError();
        signal.removeEventListener('abort', onAbort);
      }
      if (signal.aborted) return;
      if (turnError !== undefined) {
        throw turnError instanceof Error ? turnError : new Error(String(turnError));
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
        const candidate = resolveAgent(targetSessionId);
        if (candidate && isUserOrdinaryAgent(candidate)) {
          agent = candidate;
        } else if (!candidate) {
          const sc = getSessionController();
          const resolved = sc ? await sc.resolveAgent(SessionId(targetSessionId)).catch(() => undefined) : undefined;
          if (resolved && 'agent' in resolved && isUserOrdinaryAgent(resolved.agent)) {
            agent = resolved.agent;
          }
        }
      }
      if (!agent) {
        const candidates = ctx.agents.list().filter((a) => !excludeSessionIds.has(a.id) && isUserOrdinaryAgent(a));
        agent = candidates.at(-1);
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
    homeDir: options?.homeDir ?? homedir(),
    sense: ctx.asiSense,
    jobs,
    compaction,
    sessions,
  };
}
