import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-workspace';
import type { SessionRow } from '../runtime/ports.ts';

interface Summary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  origin?: string;
  formatStatus?: string;
  projections?: { values: { title?: unknown } };
}

export function sessionRows(items: readonly Summary[], archived: readonly string[] = []): SessionRow[] {
  const hidden = new Set(archived);
  return items
    .filter(
      (item) => item.origin !== 'subagent' && item.formatStatus !== 'migration-required' && !hidden.has(item.sessionId),
    )
    .map((item) => ({
      id: item.sessionId,
      title: typeof item.projections?.values.title === 'string' ? item.projections.values.title : '',
      updatedAt: item.updatedAt,
      running: item.running,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function sessionCatalog(ctx: Context) {
  return {
    async listSessions(): Promise<SessionRow[]> {
      const { items } = await ctx.sessionController.list({}, new AbortController().signal);
      return sessionRows(items, ctx.workspaceRegistry.archivedSessionIds);
    },
    async ensureSession(id: string): Promise<void> {
      const result = await ctx.sessionController.resolveAgent(SessionId(id));
      if ('error' in result) throw result.error;
    },
    onSessionsChanged(cb: (closed?: string) => void): () => void {
      const off = [
        ctx.on('session/created', () => cb()),
        ctx.on('session/disposed', (session) => cb(session.id)),
        ctx.on('agent/status', () => cb()),
        ctx.on('session/event', (_session, event) => {
          if (event.type === 'session/title' || event.type === 'user/message') cb();
        }),
        ctx.on('workspace/session-archived', ({ sessionId }) => cb(sessionId)),
      ];
      return () => {
        for (const dispose of off) dispose();
      };
    },
  };
}
