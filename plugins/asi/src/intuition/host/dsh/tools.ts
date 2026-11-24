/**
 * Global Conversation Tools for `src/intuition` (`intuition_status`,
 * `prospective_remember`, `prospective_resolve`).
 *
 * - Strictly operates inside `<storageRoot>/intuition/`, never mutates user
 *   project workspaces, and scrubs every output through `sanitizeForModel`.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  ASI_INTERNAL_CWD_RE,
  ASI_INTERNAL_SESSION_ID_RE,
  buildUnifiedExcludedInternalRoots,
} from '../../../shared/internal-guards.js';
import {
  PROSPECTIVE_EVENT_KINDS,
  PROSPECTIVE_TRIGGER_KINDS,
  type ProspectiveEventKind,
  type ProspectiveResolveAction,
  type ProspectiveTriggerKind,
} from '../../shared/types.js';
import type { IntuitionRuntime } from '../runtime.js';

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const normRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normRoot);
}

export interface IntuitionToolGuardOptions {
  excludedRoots?: readonly (string | undefined)[];
  isArchived?: (sessionId: string) => boolean;
}

function requireOrdinaryAgent(exec: ToolRunContext, guard?: IntuitionToolGuardOptions): Agent {
  const agent = exec.agent;
  if (!agent) throw new ToolContextUnavailableError('asi-intuition tools require an active agent');
  const sid = String(agent.id ?? agent.session?.id ?? '');
  if (!sid || ASI_INTERNAL_SESSION_ID_RE.test(sid) || guard?.isArchived?.(sid)) {
    throw new ToolContextUnavailableError('asi-intuition tools are restricted to ordinary user sessions');
  }
  const header = agent.session?.header as
    | { origin?: string; delegationDepth?: number; parentId?: unknown; cwd?: string }
    | undefined;
  if (
    header?.origin === 'subagent' ||
    (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) ||
    (header?.parentId !== undefined && header?.parentId !== null)
  ) {
    throw new ToolContextUnavailableError('asi-intuition tools are restricted to ordinary user sessions');
  }
  const cwd = header?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) {
    if (ASI_INTERNAL_CWD_RE.test(cwd)) {
      throw new ToolContextUnavailableError('asi-intuition tools are restricted to ordinary user sessions');
    }
    const normCwd = resolve(cwd);
    const realCwd = safeRealpath(normCwd);
    for (const rawEx of guard?.excludedRoots ?? []) {
      if (!rawEx?.trim()) continue;
      const normEx = resolve(rawEx);
      const realEx = safeRealpath(normEx);
      if (isInsideRoot(normCwd, normEx) || isInsideRoot(realCwd, realEx)) {
        throw new ToolContextUnavailableError('asi-intuition tools are restricted to ordinary user sessions');
      }
    }
  }
  return agent;
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

function isTriggerKind(val: unknown): val is ProspectiveTriggerKind {
  return typeof val === 'string' && (PROSPECTIVE_TRIGGER_KINDS as readonly string[]).includes(val);
}

function isEventKind(val: unknown): val is ProspectiveEventKind {
  return typeof val === 'string' && (PROSPECTIVE_EVENT_KINDS as readonly string[]).includes(val);
}

function isResolveAction(val: unknown): val is ProspectiveResolveAction {
  return val === 'fulfill' || val === 'snooze' || val === 'cancel';
}

export function createIntuitionStatusTool(runtime: IntuitionRuntime, guard?: IntuitionToolGuardOptions) {
  return defineTool({
    name: 'intuition_status',
    description:
      'Inspect prefrontal intuition state, pending or surfaced prospective memory reminders, and optionally run an instant (<10ms, zero-LLM) gut-feeling flashback check against consolidated pitfalls, decisions, and recent failure scars.',
    parameters: {
      contextQuery: {
        type: 'string',
        description:
          'Optional command, file, topic, or plan to scan for somatic-marker pitfall/decision flashbacks before acting.',
      },
      includeCompleted: {
        type: 'boolean',
        description: 'Include fulfilled, canceled, or expired prospective intentions (default false).',
      },
      limit: {
        type: 'number',
        description: 'Maximum prospective intentions to return (1..50, default 15).',
      },
    },
    output,
    async execute(args, exec) {
      const agent = requireOrdinaryAgent(exec, guard);
      bounded(args);
      if (args.contextQuery !== undefined && typeof args.contextQuery !== 'string') {
        throw new ToolArgsError(['contextQuery must be a string']);
      }
      if (args.includeCompleted !== undefined && typeof args.includeCompleted !== 'boolean') {
        throw new ToolArgsError(['includeCompleted must be a boolean']);
      }
      if (
        args.limit !== undefined &&
        (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1)
      ) {
        throw new ToolArgsError(['limit must be a positive number']);
      }

      const snap = runtime.serviceSnapshot();
      const includeCompleted = Boolean(args.includeCompleted);
      const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 15)));
      const intentions = runtime.listIntentionSummaries({
        ...(includeCompleted ? {} : { statuses: ['surfaced', 'pending', 'snoozed'] }),
        limit,
      });

      const cwd = agent.session?.header?.cwd;
      const flashbacks =
        typeof args.contextQuery === 'string' && args.contextQuery.trim()
          ? runtime.scanFlashbacks(args.contextQuery, {
              ...(typeof cwd === 'string' && cwd.trim() ? { cwd } : {}),
              minScore: 0.48,
              limit: 5,
            })
          : [];

      return sanitizeValueForModel({
        now: snap.now,
        autoIntuitionPaused: snap.autoIntuitionPaused,
        suppressed: snap.suppressed,
        ...(snap.suppressionReason ? { suppressionReason: snap.suppressionReason } : {}),
        pendingCount: snap.pendingCount,
        surfacedCount: snap.surfacedCount,
        fulfilledCount: snap.fulfilledCount,
        intentions,
        flashbacks,
      });
    },
  });
}

export function createProspectiveRememberTool(runtime: IntuitionRuntime, guard?: IntuitionToolGuardOptions) {
  return defineTool({
    name: 'prospective_remember',
    description:
      'Register a local prospective memory intention ("remember to do X when Y happens") in local ASI intuition storage. Supports time-based (delayMinutes), context-based (workspaceMatch / keywordMatch / appMatch), and event-based (next_session, tool_call, sleep_completed, job_finished, network_online) triggers.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short summary title of the prospective reminder.',
      },
      instruction: {
        type: 'string',
        required: true,
        description: 'Concrete action or verification check to remember when triggered.',
      },
      triggerKind: {
        type: 'string',
        required: true,
        enum: [...PROSPECTIVE_TRIGGER_KINDS],
        description: 'Trigger category: time, context, or event.',
      },
      priority: {
        type: 'string',
        enum: ['normal', 'high'],
        description: 'Optional reminder priority (default normal).',
      },
      delayMinutes: {
        type: 'number',
        description: 'Minutes from now until due (required when triggerKind="time").',
      },
      workspaceMatch: {
        type: 'string',
        description: 'Workspace name or path fragment to match against session cwd.',
      },
      keywordMatch: {
        type: 'string',
        description: 'Comma-separated keywords to match against user prompt or allowed window title.',
      },
      appMatch: {
        type: 'string',
        description: 'Foreground app name or bundleId to match when triggerKind="context".',
      },
      eventKind: {
        type: 'string',
        enum: [...PROSPECTIVE_EVENT_KINDS],
        description: 'Lifecycle event to match when triggerKind="event" (default next_session).',
      },
      toolName: {
        type: 'string',
        description: 'Optional tool name filter when eventKind="tool_call".',
      },
      targetPattern: {
        type: 'string',
        description: 'Optional command, file, or job label pattern when triggerKind="event".',
      },
      expiresInHours: {
        type: 'number',
        description: 'Optional expiration window in hours (1..8760).',
      },
    },
    output,
    async execute(args, exec) {
      const agent = requireOrdinaryAgent(exec, guard);
      bounded(args);
      if (typeof args.title !== 'string' || !args.title.trim()) {
        throw new ToolArgsError(['title must be a non-empty string']);
      }
      if (typeof args.instruction !== 'string' || !args.instruction.trim()) {
        throw new ToolArgsError(['instruction must be a non-empty string']);
      }
      if (!isTriggerKind(args.triggerKind)) {
        throw new ToolArgsError(['triggerKind must be time, context, or event']);
      }
      if (args.priority !== undefined && args.priority !== 'normal' && args.priority !== 'high') {
        throw new ToolArgsError(['priority must be normal or high']);
      }
      if (
        args.delayMinutes !== undefined &&
        (typeof args.delayMinutes !== 'number' || !Number.isFinite(args.delayMinutes) || args.delayMinutes <= 0)
      ) {
        throw new ToolArgsError(['delayMinutes must be a positive number']);
      }
      if (args.eventKind !== undefined && !isEventKind(args.eventKind)) {
        throw new ToolArgsError(['invalid eventKind']);
      }
      if (
        args.expiresInHours !== undefined &&
        (typeof args.expiresInHours !== 'number' || !Number.isFinite(args.expiresInHours) || args.expiresInHours <= 0)
      ) {
        throw new ToolArgsError(['expiresInHours must be a positive number']);
      }

      try {
        const created = await runtime.actions.createIntention(
          {
            title: args.title,
            instruction: args.instruction,
            triggerKind: args.triggerKind,
            ...(args.priority === 'high' || args.priority === 'normal' ? { priority: args.priority } : {}),
            ...(typeof args.delayMinutes === 'number' ? { delayMinutes: args.delayMinutes } : {}),
            ...(typeof args.workspaceMatch === 'string' ? { workspaceMatch: args.workspaceMatch } : {}),
            ...(typeof args.keywordMatch === 'string' ? { keywordMatch: args.keywordMatch } : {}),
            ...(typeof args.appMatch === 'string' ? { appMatch: args.appMatch } : {}),
            ...(args.eventKind ? { eventKind: args.eventKind } : {}),
            ...(typeof args.toolName === 'string' ? { toolName: args.toolName } : {}),
            ...(typeof args.targetPattern === 'string' ? { targetPattern: args.targetPattern } : {}),
            ...(typeof args.expiresInHours === 'number' ? { expiresInHours: args.expiresInHours } : {}),
          },
          String(agent.id ?? ''),
        );
        return sanitizeValueForModel({
          status: 'created',
          intention: created,
        });
      } catch (err) {
        const msg = err instanceof Error ? sanitizeForModel(err.message) : 'invalid prospective intention input';
        throw new ToolArgsError([msg]);
      }
    },
  });
}

export function createProspectiveResolveTool(runtime: IntuitionRuntime, guard?: IntuitionToolGuardOptions) {
  return defineTool({
    name: 'prospective_resolve',
    description:
      'Fulfill, snooze, or cancel a prospective memory intention after handling a surfaced reminder or updating plans.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Prospective intention id (e.g. pm_...).',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['fulfill', 'snooze', 'cancel'],
        description: 'Resolution action: fulfill (done), snooze (remind later), or cancel.',
      },
      snoozeMinutes: {
        type: 'number',
        description: 'Minutes to snooze when action="snooze" (default 30).',
      },
      note: {
        type: 'string',
        description: 'Optional brief resolution note.',
      },
    },
    output,
    async execute(args, exec) {
      requireOrdinaryAgent(exec, guard);
      bounded(args);
      if (typeof args.id !== 'string' || !args.id.trim()) {
        throw new ToolArgsError(['id must be a non-empty string']);
      }
      if (!isResolveAction(args.action)) {
        throw new ToolArgsError(['action must be fulfill, snooze, or cancel']);
      }
      if (
        args.snoozeMinutes !== undefined &&
        (typeof args.snoozeMinutes !== 'number' || !Number.isFinite(args.snoozeMinutes) || args.snoozeMinutes <= 0)
      ) {
        throw new ToolArgsError(['snoozeMinutes must be a positive number']);
      }
      if (args.note !== undefined && typeof args.note !== 'string') {
        throw new ToolArgsError(['note must be a string']);
      }

      try {
        const updated = await runtime.actions.resolveIntention({
          id: args.id,
          action: args.action,
          ...(typeof args.snoozeMinutes === 'number' ? { snoozeMinutes: args.snoozeMinutes } : {}),
          ...(typeof args.note === 'string' ? { note: args.note } : {}),
        });
        return sanitizeValueForModel({
          status: updated.status,
          intention: updated,
        });
      } catch (err) {
        const msg = err instanceof Error ? sanitizeForModel(err.message) : 'failed to resolve prospective intention';
        throw new ToolArgsError([msg]);
      }
    },
  });
}

export function registerIntuitionTools(
  ctx: Context,
  runtime: IntuitionRuntime,
  excludedRoots?: readonly (string | undefined)[],
): () => void {
  const effectiveExcluded = buildUnifiedExcludedInternalRoots(ctx.asiSense?.storageRoot, ...(excludedRoots ?? []));
  const guard: IntuitionToolGuardOptions = {
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
  const offStatus = ctx.tools.register(createIntuitionStatusTool(runtime, guard));
  const offRemember = ctx.tools.register(createProspectiveRememberTool(runtime, guard));
  const offResolve = ctx.tools.register(createProspectiveResolveTool(runtime, guard));
  return () => {
    offResolve();
    offRemember();
    offStatus();
  };
}
