/**
 * Global Read-Only Cross-Repo Insight Tool (`dream_insights`) for `asi-dream`.
 *
 * - Pure on-demand read-only tool: ZERO dynamic message injection and ZERO dynamic
 *   system-prompt mutation -> 100% Prompt Cache preservation in ordinary chats.
 * - Supports caller `cwd` repository affinity ranking or strict current-workspace filtering.
 * - Every returned field passes through `sanitizeForModel`.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { ASI_INTERNAL_SESSION_ID_RE, buildUnifiedExcludedInternalRoots } from '../../../shared/internal-guards.js';
import { sanitizeValueForModel } from '../../../sleep/host/dsh/tools.ts';
import { DREAM_INSIGHT_KINDS, type DreamInsightKind, type DreamInsightStatus } from '../../shared/types.js';
import type { DreamRuntime } from '../runtime.ts';
import { isOrdinaryDreamSession } from './dsh-ports.ts';

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const ALLOWED_STATUSES: readonly (DreamInsightStatus | 'all')[] = ['open', 'adopted', 'promoted', 'dismissed', 'all'];

export interface DreamToolGuardOptions {
  excludedRoots?: readonly (string | undefined)[];
  isArchived?: (sessionId: string) => boolean;
}

function requireOrdinaryAgent(exec: ToolRunContext, guard?: DreamToolGuardOptions): Agent {
  const agent = exec.agent;
  if (!agent) throw new ToolContextUnavailableError('dream_insights tool requires an active agent');
  const sid = String(agent.id ?? agent.session?.id ?? '');
  if (!sid || ASI_INTERNAL_SESSION_ID_RE.test(sid) || guard?.isArchived?.(sid)) {
    throw new ToolContextUnavailableError('dream_insights is restricted to ordinary user sessions');
  }
  if (agent.session && !isOrdinaryDreamSession(agent.session, guard?.excludedRoots ?? [])) {
    throw new ToolContextUnavailableError('dream_insights is restricted to ordinary user sessions');
  }
  return agent;
}

function bounded(args: unknown): void {
  if (Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > 8_192) {
    throw new ToolArgsError(['arguments exceed 8192 bytes']);
  }
}

function isInsightKind(value: unknown): value is DreamInsightKind {
  return typeof value === 'string' && (DREAM_INSIGHT_KINDS as readonly string[]).includes(value);
}

function isStatusArg(value: unknown): value is DreamInsightStatus | 'all' {
  return typeof value === 'string' && (ALLOWED_STATUSES as readonly string[]).includes(value);
}

export function createDreamInsightsTool(runtime: DreamRuntime, guard?: DreamToolGuardOptions) {
  return defineTool({
    name: 'dream_insights',
    description:
      'Read cross-repository insights (preventive-warning, structural-analogy, pattern-unification, decision-tension) synthesized offline during Default Mode Network (DMN) sleep dreaming across local Git projects.',
    parameters: {
      query: {
        type: 'string',
        description: 'Optional keywords, mechanism, stack tag, or repository name to search across DMN insights.',
      },
      kind: {
        type: 'string',
        enum: [...DREAM_INSIGHT_KINDS],
        description:
          'Optional insight category filter (preventive-warning, structural-analogy, pattern-unification, decision-tension).',
      },
      status: {
        type: 'string',
        enum: [...ALLOWED_STATUSES],
        description: 'Optional insight lifecycle filter (open, adopted, promoted, dismissed, all).',
      },
      forCurrentWorkspace: {
        type: 'boolean',
        description:
          'When true, return only cross-repo insights involving or targeting the caller session workspace repository (default false).',
      },
      limit: {
        type: 'number',
        description: 'Maximum insights to return (1..20, default 8).',
      },
    },
    output,
    async execute(args, exec) {
      const agent = requireOrdinaryAgent(exec, guard);
      bounded(args);
      if (args.query !== undefined && typeof args.query !== 'string') {
        throw new ToolArgsError(['query must be a string']);
      }
      if (args.kind !== undefined && !isInsightKind(args.kind)) {
        throw new ToolArgsError(['invalid insight kind']);
      }
      if (args.status !== undefined && !isStatusArg(args.status)) {
        throw new ToolArgsError(['invalid insight status']);
      }
      if (args.forCurrentWorkspace !== undefined && typeof args.forCurrentWorkspace !== 'boolean') {
        throw new ToolArgsError(['forCurrentWorkspace must be a boolean']);
      }
      if (
        args.limit !== undefined &&
        (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1)
      ) {
        throw new ToolArgsError(['limit must be a positive number']);
      }

      const callerCwd = agent.session?.header?.cwd;
      const res = await runtime.queryForTool({
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(callerCwd ? { callerWorkspacePath: callerCwd } : {}),
        ...(args.forCurrentWorkspace !== undefined ? { forCurrentWorkspace: Boolean(args.forCurrentWorkspace) } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return sanitizeValueForModel(res);
    },
  });
}

export function registerDreamTools(
  ctx: Context,
  runtime: DreamRuntime,
  excludedRoots?: readonly (string | undefined)[],
): () => void {
  const effectiveExcluded = buildUnifiedExcludedInternalRoots(ctx.asiSense?.storageRoot, ...(excludedRoots ?? []));
  const guard: DreamToolGuardOptions = {
    excludedRoots: effectiveExcluded,
    isArchived: (sessionId: string) => {
      try {
        const wr = (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get(
          'workspaceRegistry',
        );
        return Boolean(wr?.archivedSessionIds.some((id) => String(id) === sessionId));
      } catch {
        return false;
      }
    },
  };
  return ctx.tools.register(createDreamInsightsTool(runtime, guard));
}
