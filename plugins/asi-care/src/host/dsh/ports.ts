import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { JobId } from '@deepseek-ai/dsh-jobs';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { CareSessionBrief } from '../discovery.js';
import type { CareDshJobsPort, CareHostPorts, CareOrphanJobInfo } from '../ports.js';

export function createDshCarePorts(ctx: Context, storageRoot: string, options?: { homeDir?: string }): CareHostPorts {
  const getProfileHome = (): string | undefined => {
    const pc = (ctx as Context & { get(name: 'profileContext'): { home?: string } | undefined }).get('profileContext');
    return pc?.home?.trim() ? pc.home.trim() : undefined;
  };

  const getWorkspaceRegistry = (): WorkspaceRegistry | undefined =>
    (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get('workspaceRegistry');

  const resolveAgent = (id: string): Agent | undefined => ctx.agents.get(SessionId(id));

  const isKnownSession = (sessionId: string): boolean => {
    const sid = SessionId(sessionId);
    if (resolveAgent(sessionId)) return true;
    if (ctx.sessions?.list().some((s) => s.id === sid)) return true;
    const wr = getWorkspaceRegistry();
    return Boolean(wr?.list().some((ws) => ws.sessionIds.includes(sid)));
  };

  const collectAllActiveRawJobs = () => {
    try {
      const sessionIds = new Set([
        ...ctx.agents.list().map((a) => a.id),
        ...(ctx.sessions?.list() ?? []).map((s) => s.id),
      ]);
      const all = [ctx.jobs.list(), ...[...sessionIds].map((id) => ctx.jobs.list(id))].flat();
      return [...new Map(all.map((j) => [j.id, j])).values()].filter(
        (j) => j.status === 'running' || j.status === 'stopping',
      );
    } catch {
      return [];
    }
  };

  const ASI_INTERNAL_PATH_RE = /(?:^|[\\/])asi-(?:needs|sense|care|sleep)(?:[\\/]|$)/;

  const isInternalSession = (id: string, cwd?: string, origin?: string): boolean => {
    if (origin === 'subagent' || id.startsWith('asi-maint-')) return true;
    if (typeof cwd === 'string' && ASI_INTERNAL_PATH_RE.test(cwd)) return true;
    return false;
  };

  const jobs: CareDshJobsPort = {
    listOrphanJobs(): CareOrphanJobInfo[] {
      return collectAllActiveRawJobs()
        .filter((j) => j.status === 'running' && j.owner !== undefined && !isKnownSession(j.owner))
        .map((j) => ({
          id: j.id,
          ...(j.owner ? { owner: j.owner } : {}),
          ...(j.label ? { label: j.label } : {}),
          startedAt: j.startedAt,
        }));
    },

    listProtectedJobPids(): number[] {
      const pids = new Set<number>();
      const orphanIds = new Set<string>(
        collectAllActiveRawJobs()
          .filter((j) => j.owner !== undefined && !isKnownSession(j.owner))
          .map((j) => String(j.id)),
      );
      const senseJobs = ctx.asiSense.snapshot().state.env.activeJobs.value ?? [];
      for (const j of senseJobs) {
        if (
          j.status === 'running' &&
          !orphanIds.has(j.id) &&
          typeof j.pid === 'number' &&
          Number.isSafeInteger(j.pid) &&
          j.pid > 0
        ) {
          pids.add(j.pid);
        }
      }
      for (const j of collectAllActiveRawJobs()) {
        const rawPid = (j as { pid?: unknown }).pid;
        if (!orphanIds.has(j.id) && typeof rawPid === 'number' && Number.isSafeInteger(rawPid) && rawPid > 0) {
          pids.add(rawPid);
        }
      }
      return [...pids];
    },

    killOrphanJob(id: string, owner: string | undefined, reason: string) {
      try {
        if (owner === undefined || isKnownSession(owner)) {
          return 'already-finished';
        }
        return ctx.jobs.kill(JobId(id), SessionId(owner), reason);
      } catch {
        return 'already-finished';
      }
    },
  };

  return {
    storageRoot,
    homeDir: options?.homeDir ?? getProfileHome() ?? homedir(),
    sense: ctx.asiSense,
    drives: ctx.asiDrives,

    listWorkspacePaths(): string[] {
      const wr = getWorkspaceRegistry();
      if (!wr) return [];
      try {
        return wr
          .list()
          .map((ws) => ws.path)
          .filter((p) => typeof p === 'string' && !ASI_INTERNAL_PATH_RE.test(p));
      } catch {
        return [];
      }
    },

    listSessions(): CareSessionBrief[] {
      const out = new Map<string, CareSessionBrief>();
      const activeOwnerIds = new Set(
        collectAllActiveRawJobs()
          .map((j) => j.owner)
          .filter((id): id is SessionId => Boolean(id)),
      );
      const wr = getWorkspaceRegistry();
      const archivedSet = new Set<string>(wr?.archivedSessionIds ?? []);

      for (const s of ctx.sessions?.list() ?? []) {
        if (archivedSet.has(s.id)) continue;
        const cwd = s.header?.cwd;
        out.set(s.id, {
          id: s.id,
          ...(cwd ? { cwd } : {}),
          active: activeOwnerIds.has(s.id),
          internal: isInternalSession(s.id, cwd, s.header?.origin),
        });
      }

      for (const a of ctx.agents.list()) {
        if (archivedSet.has(a.id)) continue;
        const header = (a as { session?: { header?: { cwd?: string; origin?: string } } }).session?.header;
        const cwd = header?.cwd ?? out.get(a.id)?.cwd;
        const isActive = a.status !== 'idle' || activeOwnerIds.has(a.id);
        out.set(a.id, {
          id: a.id,
          ...(cwd ? { cwd } : {}),
          active: isActive,
          internal: isInternalSession(a.id, cwd, header?.origin),
        });
      }

      return [...out.values()];
    },

    listInternalRoots(): string[] {
      const roots = new Set<string>([storageRoot]);
      if (ctx.asiSense.storageRoot) {
        roots.add(ctx.asiSense.storageRoot);
      }
      if (basename(storageRoot) === 'asi-care') {
        const dataParent = dirname(storageRoot);
        roots.add(join(dataParent, 'asi-needs'));
        roots.add(join(dataParent, 'asi-sense'));
        roots.add(join(dataParent, 'asi-sleep'));
      }
      return [...roots];
    },

    jobs,
  };
}
