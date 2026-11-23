/**
 * Global Read-Only Tool Registration for `asi-care` (`0.3.0`).
 *
 * - Ordinary user conversations ONLY see `care_status` (strictly read-only,
 *   sanitized via `sanitizeForModel`).
 * - Zero mutation tools and zero `<asi-cry>` / dynamic message injections touch
 *   ordinary foreground chats; all maintenance tools live inside `ctx.asiDrives`
 *   sandbox scope.
 */

import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { CareRuntime } from '../runtime.js';

const ASPECTS = ['all', 'repos', 'runtime', 'bloat'] as const;

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export function sanitizeCareValueForModel(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeForModel(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCareValueForModel(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[sanitizeForModel(k)] = sanitizeCareValueForModel(v);
    }
    return out;
  }
  return null;
}

export function createCareStatusTool(runtime: CareRuntime) {
  return defineTool({
    name: 'care_status',
    description:
      'Read local workspace & project care status (L3 drives: repo_hygiene, orphan_runtime, workspace_bloat), discovered Git repositories & sibling worktrees, 2-hour active exemptions, conflicts/uncommitted changes, orphan dev ports, and idle build artifact sizes.',
    parameters: {
      aspect: {
        type: 'string',
        enum: [...ASPECTS],
        description: 'Optional focus section (`all` | `repos` | `runtime` | `bloat`, default `all`).',
      },
      refresh: {
        type: 'boolean',
        description: 'Optional request for a fresh fast probe (rate-limited by cooldown).',
      },
    },
    output,
    async execute(args, exec) {
      if (!exec.agent) {
        throw new ToolContextUnavailableError('care_status requires an active agent');
      }
      if (Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > 4_096) {
        throw new ToolArgsError(['arguments exceed 4096 bytes']);
      }
      const aspect = args.aspect ?? 'all';
      if (!(ASPECTS as readonly string[]).includes(aspect)) {
        throw new ToolArgsError(['invalid aspect']);
      }
      const snap = await runtime.statusSnapshot({
        aspect: aspect as (typeof ASPECTS)[number],
        refresh: args.refresh === true,
      });
      return sanitizeCareValueForModel(snap);
    },
  });
}

export function registerCareTools(ctx: Context, runtime: CareRuntime): () => void {
  return ctx.tools.register(createCareStatusTool(runtime));
}
