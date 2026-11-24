/**
 * Global Read-Only Tool (`partner_state`) & Constant System Prompt Section
 * for ASI Theory of Mind (`src/tom/`).
 *
 * - Constant, byte-identical `systemPrompt.section` (`asi-tom`) + on-demand
 *   read-only tool `partner_state` -> ZERO dynamic message injection and
 *   100% LLM Prefix Prompt Cache preservation.
 * - Every returned string passes through `sanitizeForModel`.
 */

import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  ASI_INTERNAL_CWD_RE,
  ASI_INTERNAL_SESSION_ID_RE,
  buildUnifiedExcludedInternalRoots,
  isInsideExcludedRoots,
} from '../../../shared/internal-guards.js';
import type { TomRuntime } from '../runtime.js';

export const ASI_TOM_SYSTEM_PROMPT_TEXT =
  'For ambiguous brief prompts, repeated interruptions or command failures, or multi-option trade-offs, call `partner_state` on demand to inspect the user partner state and collaboration tact guidance; adapt brevity, verification rigor, and question budget tacitly without announcing inferred mood.';

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export interface TomToolGuardOptions {
  excludedRoots?: readonly (string | undefined)[];
  isArchived?: (sessionId: string) => boolean;
}

export function isInternalOrSubagent(
  agent: Agent | undefined,
  guard?: Pick<TomToolGuardOptions, 'excludedRoots'>,
): boolean {
  if (!agent) return false;
  const sid = String(agent.id ?? agent.session?.id ?? '');
  if (!sid || ASI_INTERNAL_SESSION_ID_RE.test(sid)) return true;
  const header = agent.session?.header as
    | { origin?: string; delegationDepth?: number; parentId?: unknown; cwd?: string }
    | undefined;
  if (
    header?.origin === 'subagent' ||
    (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) ||
    (header?.parentId !== undefined && header?.parentId !== null)
  ) {
    return true;
  }
  const cwd = header?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) {
    if (ASI_INTERNAL_CWD_RE.test(cwd) || isInsideExcludedRoots(cwd, guard?.excludedRoots ?? [])) {
      return true;
    }
  }
  return false;
}

function requireOrdinaryAgent(exec: ToolRunContext, guard?: TomToolGuardOptions): Agent {
  if (!exec.agent) throw new ToolContextUnavailableError('partner_state requires an active agent');
  const sid = String(exec.agent.id ?? exec.agent.session?.id ?? '');
  if (isInternalOrSubagent(exec.agent, guard) || guard?.isArchived?.(sid)) {
    throw new ToolContextUnavailableError('partner_state is restricted to ordinary user sessions');
  }
  return exec.agent;
}

function bounded(args: unknown): void {
  if (Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > 4_096) {
    throw new ToolArgsError(['arguments exceed 4096 bytes']);
  }
}

export function sanitizeTomValueForModel(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeForModel(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTomValueForModel(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[sanitizeForModel(k)] = sanitizeTomValueForModel(v);
    }
    return out;
  }
  return null;
}

export function createPartnerStateTool(runtime: Pick<TomRuntime, 'toolReport'>, guard?: TomToolGuardOptions) {
  return defineTool({
    name: 'partner_state',
    description:
      'Read inferred human partner cognitive state (deep_focus, rapid_sprint, stuck_debugging, exploring, steady_flow, away_resting), continuous focus/friction/pace/presence dimensions, explainable signals, and concrete collaborative tact guidance (verbosity, autonomy, question budget).',
    parameters: {
      includePreferences: {
        type: 'boolean',
        description:
          'Include high-retention consolidated collaboration preferences from long-term memory when available (default true).',
      },
      includeBaseline: {
        type: 'boolean',
        description:
          'Include individualized EWMA interaction cadence and prompt length baseline summary (default false).',
      },
    },
    output,
    async execute(args, exec) {
      requireOrdinaryAgent(exec, guard);
      bounded(args);
      if (args.includePreferences !== undefined && typeof args.includePreferences !== 'boolean') {
        throw new ToolArgsError(['includePreferences must be a boolean']);
      }
      if (args.includeBaseline !== undefined && typeof args.includeBaseline !== 'boolean') {
        throw new ToolArgsError(['includeBaseline must be a boolean']);
      }
      const report = runtime.toolReport({
        ...(args.includePreferences !== undefined ? { includePreferences: args.includePreferences } : {}),
        ...(args.includeBaseline !== undefined ? { includeBaseline: args.includeBaseline } : {}),
      });
      return sanitizeTomValueForModel(report);
    },
  });
}

export function registerTomTools(
  ctx: Context,
  runtime: Pick<TomRuntime, 'toolReport'>,
  excludedRoots?: readonly (string | undefined)[],
): () => void {
  const effectiveExcluded = buildUnifiedExcludedInternalRoots(ctx.asiSense?.storageRoot, ...(excludedRoots ?? []));
  const guard: TomToolGuardOptions = {
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
  const disposers: (() => void)[] = [];
  try {
    disposers.push(ctx.tools.register(createPartnerStateTool(runtime, guard)));
    disposers.push(
      ctx.systemPrompt.section({
        name: 'asi-tom',
        order: 2705,
        text: (assembleCtx) => {
          const candidateAgent =
            (assembleCtx as { agent?: Agent }).agent ??
            (assembleCtx.scope && typeof assembleCtx.scope === 'object' ? (assembleCtx.scope as Agent) : undefined);
          return isInternalOrSubagent(candidateAgent, guard) ? '' : ASI_TOM_SYSTEM_PROMPT_TEXT;
        },
      }),
    );
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
