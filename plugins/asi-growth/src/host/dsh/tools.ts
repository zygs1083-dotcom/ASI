/**
 * Global Read-Only Tool (`growth_status`) for `asi-growth` (`0.5.0`).
 *
 * - Pure on-demand read-only tool: ZERO dynamic message injection and ZERO
 *   system-prompt mutation -> 100% Prompt Cache preservation in ordinary chats.
 * - Every returned string passes through `sanitizeForModel`.
 */

import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { SkillScope } from '../../shared/types.js';
import type { GrowthRuntime } from '../runtime.js';

const STATUS_FILTERS = ['draft', 'active', 'disabled', 'archived', 'stale'] as const;
const SCOPE_FILTERS: readonly SkillScope[] = ['global', 'workspace'];

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new ToolContextUnavailableError('asi-growth tools require an active agent');
  return exec.agent;
}

function bounded(args: unknown): void {
  if (Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > 8_192) {
    throw new ToolArgsError(['arguments exceed 8192 bytes']);
  }
}

export function sanitizeValueForModel(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeForModel(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValueForModel(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[sanitizeForModel(k)] = sanitizeValueForModel(v);
    }
    return out;
  }
  return null;
}

export function createGrowthStatusTool(runtime: GrowthRuntime) {
  return defineTool({
    name: 'growth_status',
    description:
      'Read L4 skill self-evolution status, pending SKILL.md drafts awaiting human approval, active/disabled/archived skills mounted via ctx.skills, and 60-day invocation metabolism metrics.',
    parameters: {
      status: {
        type: 'string',
        enum: [...STATUS_FILTERS],
        description: 'Optional status filter (draft, active, disabled, archived, stale).',
      },
      scope: {
        type: 'string',
        enum: [...SCOPE_FILTERS],
        description: 'Optional scope filter (global, workspace).',
      },
    },
    output,
    async execute(args, exec) {
      requireAgent(exec);
      bounded(args);
      if (args.status !== undefined && !(STATUS_FILTERS as readonly string[]).includes(args.status)) {
        throw new ToolArgsError(['invalid status filter']);
      }
      if (args.scope !== undefined && !(SCOPE_FILTERS as readonly string[]).includes(args.scope)) {
        throw new ToolArgsError(['invalid scope filter']);
      }
      await runtime.vault.syncExternalDiskEdits();
      const snapshot = runtime.statusSnapshot({
        ...(args.status ? { status: args.status as (typeof STATUS_FILTERS)[number] } : {}),
        ...(args.scope ? { scope: args.scope as SkillScope } : {}),
      });
      return sanitizeValueForModel(snapshot);
    },
  });
}

export function registerGrowthTools(ctx: Context, runtime: GrowthRuntime): () => void {
  return ctx.tools.register(createGrowthStatusTool(runtime));
}
