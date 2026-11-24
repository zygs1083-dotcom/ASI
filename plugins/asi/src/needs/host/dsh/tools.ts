/**
 * Tool registration & scope isolation for `asi-needs` (`0.3.0`):
 * - Globally (ordinary conversations): registers ONLY read-only `needs_status`
 *   (sanitized via `sanitizeForModel`). Zero maintenance action tools, zero
 *   sniffer tools, and zero dynamic `<env-update>` injections touch ordinary chats.
 * - Dedicated background self-maintenance session (`agent.ctx` scope):
 *   1. `agent.ctx.tools.restrict` strips non-whitelisted global tools (`shell`,
 *      `write_file`, `computer_use`, etc.), keeping only `env_state`, `env_detail`,
 *      and `needs_status`.
 *   2. Registers `needs_sniff_causes` (read-only panoramic cause sniffer) + the 4
 *      safe sandboxed maintenance tools (`needs_clean_cache`, `needs_stop_job`,
 *      `needs_compact_context`, `needs_request_help`) + any higher-order plugin
 *      sandbox tools registered via `ctx.asiDrives` ONLY in `agent.ctx.tools`.
 *   3. Installs `agent.ctx.tools.guard` as defense-in-depth denying any non-whitelisted
 *      tool AND dynamically suspending L2–L4 drive tools whenever L1 physiological
 *      distress or `'eco'` mode is active.
 */

import { type HelpActionKind, NEED_KEYS, type NeedKey, sanitizeForModel } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import {
  defineTool,
  type ParameterSchemaSpec,
  ToolArgsError,
  ToolContextUnavailableError,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { fastSafeRealpath } from '../../../shared/internal-guards.js';
import { CLEANABLE_EXTERNAL_CACHE_IDS } from '../cache-catalog.js';
import type { RegisteredSandboxTool } from '../drives.js';
import { type NeedsRuntime, validateHelpActionTarget } from '../runtime.js';

const READONLY_GLOBAL_ALLOW = ['env_state', 'env_detail', 'needs_status', 'care_status'] as const;

export const MAINTENANCE_ACTION_TOOL_NAMES = [
  'needs_sniff_causes',
  'needs_clean_cache',
  'needs_stop_job',
  'needs_compact_context',
  'needs_request_help',
] as const;

const ALLOWED_MAINTAINER_TOOLS = new Set<string>([...READONLY_GLOBAL_ALLOW, ...MAINTENANCE_ACTION_TOOL_NAMES]);

const ACTION_KINDS: readonly HelpActionKind[] = [
  'acknowledge',
  'clean-cache',
  'clean-external-cache',
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
      'Read the 5 homeostatic survival needs (energy, space, memory, mind, thermals), arbitrated higher-order drives, action-outcome ledger, instinct reflex status, background self-maintenance status, and open help cards.',
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
          actionLedger: (snap.actionLedger ?? []).filter((e) => e.need === key),
        });
      }
      return sanitizeValueForModel(snap);
    },
  });
}

export function createMaintenanceActionTools(runtime: NeedsRuntime) {
  const sniffCauses = defineTool({
    name: 'needs_sniff_causes',
    description:
      'Read-only panoramic cause sniffer for the internal maintenance session: scans whitelisted developer cache sizes (Xcode DerivedData/Archives, Homebrew, pnpm, npm, pip, uv, Cargo, Go, Gradle, Playwright) distinguishing total vs >1h reclaimable bytes, read-only Trash size hint, and Top CPU/memory OS processes.',
    parameters: {},
    output,
    async execute(args, exec) {
      requireMaintainer(exec, runtime);
      bounded(args);
      return sanitizeValueForModel(await runtime.tools.sniffCauses());
    },
  });

  const cleanCache = defineTool({
    name: 'needs_clean_cache',
    description:
      'Safely clean expired/temporary files strictly inside ASI plugin-owned cache/tmp sandbox directories. Never touches external developer caches, Trash, user files, or symlinks.',
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
      'File a Help Card in the sidebar and send a concise one-time <asi-cry> notice to the user when safe self-rescue cannot relieve distress, when external safe/caution developer caches require one-click user approval, or when hitting a user-file/hardware/permission boundary.',
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
      actionTarget: {
        type: 'string',
        description: `Controlled whitelist target identifier (for clean-external-cache: one of ${CLEANABLE_EXTERNAL_CACHE_IDS.join(', ')}; arbitrary paths and macos-trash are strictly rejected).`,
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
      if (args.actionKind !== undefined && !(ACTION_KINDS as readonly string[]).includes(args.actionKind)) {
        throw new ToolArgsError(['invalid actionKind']);
      }
      const actionKind = (args.actionKind as HelpActionKind | undefined) ?? 'acknowledge';
      let validatedTarget: string | undefined;
      try {
        validatedTarget = validateHelpActionTarget(actionKind, args.actionTarget);
      } catch (err) {
        throw new ToolArgsError([err instanceof Error ? err.message : 'invalid actionTarget']);
      }
      const severity = args.severity === 'critical' || args.severity === 'uncomfortable' ? args.severity : undefined;
      try {
        return sanitizeValueForModel(
          await runtime.tools.requestHelp({
            need: args.need as NeedKey,
            ...(severity ? { severity } : {}),
            title: args.title,
            summary: args.summary,
            ...(args.proposedAction ? { proposedAction: args.proposedAction } : {}),
            actionKind,
            ...(validatedTarget ? { actionTarget: validatedTarget } : {}),
          }),
        );
      } catch (err) {
        throw new ToolArgsError([err instanceof Error ? err.message : 'invalid help card request']);
      }
    },
  });

  return [sniffCauses, cleanCache, stopJob, compactContext, requestHelp];
}

function createExternalDriveTool(registered: RegisteredSandboxTool, runtime: NeedsRuntime) {
  const params: ParameterSchemaSpec = {};
  for (const [k, p] of Object.entries(registered.spec.parameters ?? {})) {
    const req = p.required ? ({ required: true as const } as const) : {};
    const desc = p.description ? { description: p.description } : {};
    if (p.type === 'string') {
      params[k] = {
        type: 'string',
        ...desc,
        ...req,
        ...(p.enum ? { enum: [...p.enum] } : {}),
      };
    } else if (p.type === 'number') {
      params[k] = { type: 'number', ...desc, ...req };
    } else if (p.type === 'boolean') {
      params[k] = { type: 'boolean', ...desc, ...req };
    }
  }
  return defineTool({
    name: registered.spec.name,
    description: `[L${registered.tier} ${registered.sourceId}] ${registered.spec.description}`,
    parameters: params,
    output,
    async execute(args, exec) {
      requireMaintainer(exec, runtime);
      bounded(args);
      if (!runtime.drives) {
        throw new ToolContextUnavailableError('asiDrives runtime is not available');
      }
      const guard = runtime.drives.checkSandboxToolGuard(registered.spec.name);
      if (!guard.allowed) {
        throw new ToolContextUnavailableError(guard.reason ?? 'Higher-order drive tool is currently suspended');
      }
      const result = await runtime.drives.executeSandboxTool(
        registered,
        (args ?? {}) as Record<string, unknown>,
        exec.signal,
      );
      return sanitizeValueForModel(result);
    },
  });
}

function tryRealpath(p: string): string {
  return fastSafeRealpath(p);
}

function ensureMaintainerRegistered(agent: Agent, runtime: NeedsRuntime): boolean {
  if (runtime.isMaintenanceSession(agent.id)) return true;
  const cwd = (agent as { session?: { header?: { cwd?: string } } }).session?.header?.cwd;
  if (!cwd || !runtime.sandboxDir) return false;
  if (cwd === runtime.sandboxDir || tryRealpath(cwd) === tryRealpath(runtime.sandboxDir)) {
    runtime.registerMaintenanceSessionId(agent.id);
    return true;
  }
  return false;
}

export function attachMaintainerScope(rootCtx: Context, agent: Agent, runtime: NeedsRuntime): () => void {
  if (!ensureMaintainerRegistered(agent, runtime)) return () => {};

  const disposers: (() => void)[] = [];
  const extDisposers: (() => void)[] = [];

  try {
    const scopedTools = agent.ctx.get('tools');
    if (!scopedTools) {
      throw new Error('tools service is not available on agent.ctx');
    }
    let restrictOff: (() => void) | undefined;
    const syncRestrict = () => {
      restrictOff?.();
      restrictOff = undefined;
      const globalNames = rootCtx.tools.definitions().map((d) => d.name);
      const allow = READONLY_GLOBAL_ALLOW.filter((name) => globalNames.includes(name));
      if (allow.length > 0) {
        restrictOff = scopedTools.restrict({ allow: [...allow] });
      } else if (globalNames.length > 0) {
        restrictOff = scopedTools.restrict({ deny: globalNames });
      }
    };
    syncRestrict();
    disposers.push(() => {
      restrictOff?.();
      restrictOff = undefined;
    });

    for (const tool of createMaintenanceActionTools(runtime)) {
      disposers.push(scopedTools.register(tool));
    }

    const syncExternalTools = () => {
      syncRestrict();
      for (const off of extDisposers.splice(0).reverse()) off();
      for (const reg of runtime.drives?.registeredSandboxTools() ?? []) {
        extDisposers.push(scopedTools.register(createExternalDriveTool(reg, runtime)));
      }
    };
    syncExternalTools();
    if (runtime.drives) {
      disposers.push(runtime.drives.onToolsStructureChanged(syncExternalTools));
    }

    disposers.push(
      scopedTools.guard((exec) => {
        if (exec.name === 'needs_request_help' && runtime.isHigherOrderTurnActive?.()) {
          return 'needs_request_help (<asi-cry>) is forbidden during higher-order L2-L4 maintenance turns; use the drive silent help card tool instead';
        }
        if (ALLOWED_MAINTAINER_TOOLS.has(exec.name)) return undefined;
        const ext = runtime.drives?.checkSandboxToolGuard(exec.name);
        return ext?.allowed ? undefined : (ext?.reason ?? 'ASI maintenance sandbox forbids non-whitelisted tools');
      }),
    );

    const scopedSystemPrompt = agent.ctx.get('systemPrompt');
    if (scopedSystemPrompt) {
      disposers.push(
        scopedSystemPrompt.section({
          name: 'asi-needs-maintainer',
          order: 2710,
          text: [
            'You are the dedicated background self-maintenance agent of ASI.',
            'Operate strictly inside your read-only diagnostics (needs_status, needs_sniff_causes, care_status, env_state, env_detail) and safe sandbox tools (needs_clean_cache, needs_stop_job, needs_compact_context, needs_request_help, plus active non-suppressed higher-order drive tools).',
            'Never attempt to empty Trash, delete user files, kill external applications, or alter system configuration; for external safe/caution developer caches use needs_request_help with actionKind="clean-external-cache" and a whitelisted targetId; for higher-order drives (L2-L4) never call needs_request_help (<asi-cry>) and always use their silent help card tool.',
          ].join(' '),
        }),
      );
    }
  } catch (err) {
    for (const off of extDisposers.splice(0).reverse()) off();
    for (const d of disposers.reverse()) d();
    throw err;
  }

  return () => {
    for (const off of extDisposers.splice(0).reverse()) off();
    for (const d of disposers.splice(0).reverse()) d();
  };
}

export function registerNeedsTools(ctx: Context, runtime: NeedsRuntime): () => void {
  const disposers: (() => void)[] = [];
  const scopedDisposers = new Map<string, () => void>();

  try {
    disposers.push(ctx.tools.register(createNeedsStatusTool(runtime)));

    const bindAgent = (agent: Agent) => {
      if (!ensureMaintainerRegistered(agent, runtime) || scopedDisposers.has(agent.id)) return;
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
