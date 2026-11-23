/**
 * Tool registration & scope isolation for `asi-needs`:
 * - Globally (ordinary conversations): registers ONLY read-only `needs_status`
 *   (sanitized via `sanitizeForModel`). Zero maintenance action tools and zero
 *   dynamic `<env-update>` injections touch ordinary conversations.
 * - Dedicated background self-maintenance session (`agent.ctx` scope):
 *   1. `agent.ctx.tools.restrict` strips non-whitelisted global tools (`shell`,
 *      `write_file`, `computer_use`, etc.), keeping only `env_state`, `env_detail`,
 *      and `needs_status`.
 *   2. Registers the 4 safe sandboxed maintenance tools (`needs_clean_cache`,
 *      `needs_stop_job`, `needs_compact_context`, `needs_request_help`) ONLY in
 *      `agent.ctx.tools`.
 *   3. Installs `agent.ctx.tools.guard` as defense-in-depth denying any tool
 *      outside the 7 whitelisted names.
 */

import { type HelpActionKind, NEED_KEYS, type NeedKey, sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { NeedsRuntime } from '../runtime.js';

const READONLY_GLOBAL_ALLOW = ['env_state', 'env_detail', 'needs_status'] as const;

export const MAINTENANCE_ACTION_TOOL_NAMES = [
  'needs_clean_cache',
  'needs_stop_job',
  'needs_compact_context',
  'needs_request_help',
] as const;

const ALLOWED_MAINTAINER_TOOLS = new Set<string>([...READONLY_GLOBAL_ALLOW, ...MAINTENANCE_ACTION_TOOL_NAMES]);

const ACTION_KINDS: readonly HelpActionKind[] = [
  'acknowledge',
  'clean-cache',
  'stop-stuck-jobs',
  'compact-context',
  'enable-eco',
  'open-permissions',
];

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new ToolContextUnavailableError('asi-needs tools require an active agent');
  return exec.agent;
}

function requireMaintainer(exec: ToolRunContext, runtime: NeedsRuntime): Agent {
  const agent = requireAgent(exec);
  if (!runtime.isMaintenanceSession(agent.id)) {
    throw new ToolContextUnavailableError(
      'This maintenance tool is restricted to the internal ASI maintenance session',
    );
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

export function createNeedsStatusTool(runtime: NeedsRuntime) {
  return defineTool({
    name: 'needs_status',
    description:
      'Read the 5 homeostatic survival needs (energy, space, memory, mind, thermals), instinct reflex status, background self-maintenance status, and open help cards.',
    parameters: {
      need: {
        type: 'string',
        enum: [...NEED_KEYS],
        description: 'Optional single need key to inspect; omit for full homeostatic snapshot.',
      },
    },
    output,
    async execute(args, exec) {
      requireAgent(exec);
      bounded(args);
      const snap = runtime.tools.statusSnapshot();
      if (args.need !== undefined) {
        if (!(NEED_KEYS as readonly string[]).includes(args.need)) {
          throw new ToolArgsError(['invalid need key']);
        }
        const key = args.need as NeedKey;
        return sanitizeValueForModel({
          now: snap.now,
          paused: snap.paused,
          need: snap.needs[key],
          instinct: snap.instinct,
          helpCards: snap.helpCards.filter((c) => c.need === key && c.status === 'open'),
        });
      }
      return sanitizeValueForModel(snap);
    },
  });
}

export function createMaintenanceActionTools(runtime: NeedsRuntime) {
  const cleanCache = defineTool({
    name: 'needs_clean_cache',
    description:
      'Safely clean expired/temporary files strictly inside ASI plugin-owned cache/tmp sandbox directories. Never touches user files or follows symlinks.',
    parameters: {},
    output,
    async execute(args, exec) {
      requireMaintainer(exec, runtime);
      bounded(args);
      return sanitizeValueForModel(await runtime.tools.cleanCache());
    },
  });

  const stopJob = defineTool({
    name: 'needs_stop_job',
    description:
      'Stop stuck or orphaned DSH-managed background jobs (running past the stuck threshold or without a live session owner). Refuses normal active user jobs and external OS processes.',
    parameters: {
      jobId: {
        type: 'string',
        description: 'Optional specific stuck DSH job ID; omit to stop all eligible stuck/orphaned DSH jobs.',
      },
    },
    output,
    async execute(args, exec) {
      requireMaintainer(exec, runtime);
      bounded(args);
      return sanitizeValueForModel(await runtime.tools.stopStuckJob(args.jobId));
    },
  });

  const compactContext = defineTool({
    name: 'needs_compact_context',
    description:
      'Trigger context compaction on idle sessions experiencing token pressure, or schedule rotation of the internal maintenance session.',
    parameters: {},
    output,
    async execute(args, exec) {
      requireMaintainer(exec, runtime);
      bounded(args);
      return sanitizeValueForModel(await runtime.tools.compactContext());
    },
  });

  const requestHelp = defineTool({
    name: 'needs_request_help',
    description:
      'File a Help Card in the sidebar and send a concise one-time <asi-cry> notice to the user when safe self-rescue cannot relieve distress or hits a user-file/hardware/permission boundary.',
    parameters: {
      need: {
        type: 'string',
        enum: [...NEED_KEYS],
        required: true,
        description: 'Which survival need requires human assistance.',
      },
      severity: {
        type: 'string',
        enum: ['uncomfortable', 'critical'],
        description: 'Distress severity (defaults to the current evaluated zone).',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Short actionable title (<=80 chars).',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'Concise factual explanation of what was tried and why human help is needed.',
      },
      proposedAction: {
        type: 'string',
        description: 'Recommended step for the user to take.',
      },
      actionKind: {
        type: 'string',
        enum: [...ACTION_KINDS],
        description: 'One-click approval action kind (default acknowledge).',
      },
    },
    output,
    async execute(args, exec) {
      requireMaintainer(exec, runtime);
      bounded(args);
      if (!(NEED_KEYS as readonly string[]).includes(args.need)) {
        throw new ToolArgsError(['invalid need']);
      }
      if (!args.title?.trim() || !args.summary?.trim()) {
        throw new ToolArgsError(['title and summary are required']);
      }
      const actionKind =
        args.actionKind && (ACTION_KINDS as readonly string[]).includes(args.actionKind)
          ? (args.actionKind as HelpActionKind)
          : 'acknowledge';
      const severity = args.severity === 'critical' || args.severity === 'uncomfortable' ? args.severity : undefined;
      return sanitizeValueForModel(
        await runtime.tools.requestHelp({
          need: args.need as NeedKey,
          ...(severity ? { severity } : {}),
          title: args.title,
          summary: args.summary,
          ...(args.proposedAction ? { proposedAction: args.proposedAction } : {}),
          actionKind,
        }),
      );
    },
  });

  return [cleanCache, stopJob, compactContext, requestHelp];
}

export function attachMaintainerScope(rootCtx: Context, agent: Agent, runtime: NeedsRuntime): () => void {
  if (!runtime.isMaintenanceSession(agent.id)) return () => {};

  const disposers: (() => void)[] = [];
  try {
    const scopedTools = agent.ctx.get('tools');
    if (!scopedTools) {
      throw new Error('tools service is not available on agent.ctx');
    }
    const globalNames = rootCtx.tools.definitions().map((d) => d.name);
    const allow = READONLY_GLOBAL_ALLOW.filter((name) => globalNames.includes(name));
    if (allow.length > 0) {
      disposers.push(scopedTools.restrict({ allow: [...allow] }));
    } else if (globalNames.length > 0) {
      disposers.push(scopedTools.restrict({ deny: globalNames }));
    }

    for (const tool of createMaintenanceActionTools(runtime)) {
      disposers.push(scopedTools.register(tool));
    }

    disposers.push(
      scopedTools.guard((exec) =>
        ALLOWED_MAINTAINER_TOOLS.has(exec.name) ? undefined : 'ASI maintenance sandbox forbids non-whitelisted tools',
      ),
    );

    const scopedSystemPrompt = agent.ctx.get('systemPrompt');
    if (scopedSystemPrompt) {
      disposers.push(
        scopedSystemPrompt.section({
          name: 'asi-needs-maintainer',
          order: 2710,
          text: [
            'You are the dedicated background self-maintenance agent of ASI.',
            'Operate strictly inside your read-only diagnostics (needs_status, env_state, env_detail) and safe sandbox tools (needs_clean_cache, needs_stop_job, needs_compact_context, needs_request_help).',
            'Never attempt to delete user files, kill external applications, or alter system configuration; use needs_request_help when human intervention is required.',
          ].join(' '),
        }),
      );
    }
  } catch (err) {
    for (const d of disposers.reverse()) d();
    throw err;
  }

  return () => {
    for (const d of disposers.splice(0).reverse()) d();
  };
}

export function registerNeedsTools(ctx: Context, runtime: NeedsRuntime): () => void {
  const disposers: (() => void)[] = [];
  const scopedDisposers = new Map<string, () => void>();

  try {
    disposers.push(ctx.tools.register(createNeedsStatusTool(runtime)));

    const bindAgent = (agent: Agent) => {
      if (!runtime.isMaintenanceSession(agent.id) || scopedDisposers.has(agent.id)) return;
      scopedDisposers.set(agent.id, attachMaintainerScope(ctx, agent, runtime));
    };

    for (const agent of ctx.agents.list()) {
      bindAgent(agent);
    }

    disposers.push(
      ctx.on('agent/created', ({ agent }) => {
        bindAgent(agent);
      }),
    );
    disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        const off = scopedDisposers.get(agent.id);
        off?.();
        scopedDisposers.delete(agent.id);
      }),
    );
  } catch (err) {
    for (const off of scopedDisposers.values()) off();
    scopedDisposers.clear();
    for (const d of disposers.reverse()) d();
    throw err;
  }

  return () => {
    for (const off of scopedDisposers.values()) off();
    scopedDisposers.clear();
    for (const d of disposers.splice(0).reverse()) d();
  };
}
