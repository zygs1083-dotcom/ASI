/**
 * Global Read-Only Memory Tools (`memory_recall` & `memory_profile`) for `asi-sleep`.
 *
 * - Pure on-demand tools: ZERO dynamic message injection and ZERO dynamic
 *   system-prompt mutation -> 100% Prompt Cache preservation in ordinary chats.
 * - `memory_recall` strengthens FSRS retention on hits for ordinary user chats.
 * - Every returned string passes through `sanitizeForModel`.
 */

import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { MEMORY_KINDS, type MemoryKind } from '../../shared/types.js';
import type { SleepRuntime } from '../runtime.js';
import { INTERNAL_SESSION_ID_RE, isOrdinaryDshSession } from './dsh-ports.js';

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new ToolContextUnavailableError('asi-sleep memory tools require an active agent');
  return exec.agent;
}

function bounded(args: unknown): void {
  if (Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > 8_192) {
    throw new ToolArgsError(['arguments exceed 8192 bytes']);
  }
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
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

export function createMemoryRecallTool(
  runtime: SleepRuntime,
  excludedRoots: readonly (string | undefined)[] = [],
  isArchivedSession?: (sessionId: string) => boolean,
) {
  return defineTool({
    name: 'memory_recall',
    description:
      'Search consolidated long-term memories (preference, decision, pitfall, episode) from the local ASI memory vault using BM25 + prefix/fuzzy CJK & English search, ranked by relevance and FSRS retention. Strengthens FSRS retention on recall hits.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keywords, topic, or question to recall from long-term memory.',
      },
      kind: {
        type: 'string',
        enum: [...MEMORY_KINDS],
        description: 'Optional memory kind filter (preference, decision, pitfall, episode).',
      },
      limit: {
        type: 'number',
        description: 'Maximum hits to return (1..20, default 8).',
      },
      includeLowRetention: {
        type: 'boolean',
        description: 'Include faded memories below 20% FSRS retention (default false).',
      },
    },
    output,
    async execute(args, exec) {
      const agent = requireAgent(exec);
      bounded(args);
      if (typeof args.query !== 'string' || !args.query.trim()) {
        throw new ToolArgsError(['query must be a non-empty string']);
      }
      if (args.kind !== undefined && !isMemoryKind(args.kind)) {
        throw new ToolArgsError(['invalid memory kind']);
      }
      if (
        args.limit !== undefined &&
        (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1)
      ) {
        throw new ToolArgsError(['limit must be a positive number']);
      }
      if (args.includeLowRetention !== undefined && typeof args.includeLowRetention !== 'boolean') {
        throw new ToolArgsError(['includeLowRetention must be a boolean']);
      }
      const sid = String(agent.id ?? '');
      const ordinaryCaller =
        !isArchivedSession?.(sid) &&
        (agent.session ? isOrdinaryDshSession(agent.session, excludedRoots) : !INTERNAL_SESSION_ID_RE.test(sid));

      const result = await runtime.recall({
        query: args.query,
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.includeLowRetention !== undefined ? { includeLowRetention: Boolean(args.includeLowRetention) } : {}),
        strengthen: ordinaryCaller,
      });
      return sanitizeValueForModel(result);
    },
  });
}

export function createMemoryProfileTool(runtime: SleepRuntime) {
  return defineTool({
    name: 'memory_profile',
    description:
      'Read a structured profile overview of pinned and high-retention user preferences, key architectural/product decisions, pitfalls, and recent episodes from the local ASI memory vault.',
    parameters: {
      kind: {
        type: 'string',
        enum: [...MEMORY_KINDS],
        description: 'Optional single memory kind to inspect; omit for full grouped profile.',
      },
      limitPerKind: {
        type: 'number',
        description: 'Maximum entries per memory kind (1..15, default 5).',
      },
    },
    output,
    async execute(args, exec) {
      requireAgent(exec);
      bounded(args);
      if (args.kind !== undefined && !isMemoryKind(args.kind)) {
        throw new ToolArgsError(['invalid memory kind']);
      }
      if (
        args.limitPerKind !== undefined &&
        (typeof args.limitPerKind !== 'number' || !Number.isFinite(args.limitPerKind) || args.limitPerKind < 1)
      ) {
        throw new ToolArgsError(['limitPerKind must be a positive number']);
      }
      await runtime.vault.syncExternalChanges();
      const snapshot = runtime.profile({
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.limitPerKind !== undefined ? { limitPerKind: args.limitPerKind } : {}),
      });
      return sanitizeValueForModel(snapshot);
    },
  });
}

export function registerSleepTools(
  ctx: Context,
  runtime: SleepRuntime,
  excludedRoots: readonly (string | undefined)[] = [],
): () => void {
  const isArchivedSession = (sessionId: string): boolean => {
    const wr = (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get(
      'workspaceRegistry',
    );
    return Boolean(wr?.archivedSessionIds.some((id) => String(id) === sessionId));
  };
  const offRecall = ctx.tools.register(createMemoryRecallTool(runtime, excludedRoots, isArchivedSession));
  const offProfile = ctx.tools.register(createMemoryProfileTool(runtime));
  return () => {
    offProfile();
    offRecall();
  };
}
