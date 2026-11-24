import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDshNeedsPorts } from '../../src/needs/host/dsh/dsh-ports.js';
import {
  createMaintenanceActionTools,
  MAINTENANCE_ACTION_TOOL_NAMES,
  registerNeedsTools,
} from '../../src/needs/host/dsh/tools.js';
import { createNeedsRuntime } from '../../src/needs/host/runtime.js';
import { createMockSenseService } from './fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function makeAgent(root: Context, id: string): Agent {
  const agent = {
    id: SessionId(id),
    status: 'idle' as const,
  } as { id: SessionId; status: 'idle'; ctx?: Context };
  agent.ctx = createScope(root, agent).ctx;
  return agent as unknown as Agent;
}

describe('工具作用域隔离：普通对话 vs 专用后台自维护会话', () => {
  it('普通对话只见只读查询工具（env_state/env_detail/needs_status + 用户业务工具），绝不见任何维护动作工具；自维护会话只见只读工具 + 4 个白名单维护工具且剥离 shell', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-tools-'));
    tempDirs.push(storageRoot);

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    root.tools.setExecutor(new NativeToolExecutor(root));

    // 模拟全局已有的 asi-sense 只读工具与危险业务工具（shell / write_file）
    for (const name of ['env_state', 'env_detail', 'shell', 'write_file']) {
      root.tools.register(
        defineTool({
          name,
          description: `mock ${name}`,
          parameters: {},
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          async execute() {
            return { ok: true };
          },
        }),
      );
    }

    const agentsList: Agent[] = [];
    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
    });

    let createdMaintId = '';
    const sense = createMockSenseService();
    const runtime = createNeedsRuntime({
      storageRoot,
      sense,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession: async (requestedId) => {
          createdMaintId = requestedId;
          const maintAgent = makeAgent(root, requestedId);
          agentsList.push(maintAgent);
          emitAgentEvent(root, maintAgent, 'agent/created', { source: 'startup' });
          return requestedId;
        },
        hasSession: (id) => id === createdMaintId,
        runMaintenanceTurn: vi.fn(async () => {}),
        deliverCryToUserSession: vi.fn(async () => true),
      },
      probeEndpoint: async () => true,
    });

    const offTools = registerNeedsTools(root, runtime);
    await runtime.start();

    try {
      // 1. 创建普通用户对话 Agent
      const userAgent = makeAgent(root, 'ordinary-chat-1');
      agentsList.push(userAgent);
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'startup' });

      const userVisibleTools = root.tools.definitions(userAgent).map((d) => d.name);
      expect(userVisibleTools).toContain('env_state');
      expect(userVisibleTools).toContain('env_detail');
      expect(userVisibleTools).toContain('needs_status');
      expect(userVisibleTools).toContain('shell');
      for (const maintTool of MAINTENANCE_ACTION_TOOL_NAMES) {
        expect(userVisibleTools).not.toContain(maintTool);
        expect(root.tools.executable(maintTool, userAgent)).toBeUndefined();
      }

      // 即使绕过注册表直接调用维护工具 execute，普通对话身份也会被 requireMaintainer 拦截拒绝
      const directTools = createMaintenanceActionTools(runtime);
      const firstMaintTool = directTools[0];
      expect(firstMaintTool).toBeDefined();
      await expect(
        firstMaintTool?.execute({}, {
          agent: userAgent,
          signal: new AbortController().signal,
          callId: 'c1' as never,
        } as never),
      ).rejects.toThrow(/restricted to the internal ASI maintenance session/);

      // 2. 唤醒专用后台自维护会话
      const maintId = await runtime.actions.openMaintenanceSession();
      const maintAgent = agentsList.find((a) => a.id === maintId);
      expect(maintAgent).toBeDefined();
      expect(sense.internalSessions().has(maintId)).toBe(true);

      if (!maintAgent) throw new Error('missing maintAgent');
      const maintVisibleTools = root.tools
        .definitions(maintAgent)
        .map((d) => d.name)
        .sort();
      expect(maintVisibleTools).toEqual(
        [
          'env_detail',
          'env_state',
          'needs_clean_cache',
          'needs_compact_context',
          'needs_request_help',
          'needs_sniff_causes',
          'needs_status',
          'needs_stop_job',
        ].sort(),
      );
      expect(
        maintAgent.ctx
          .get('tools')
          ?.definitions(maintAgent)
          .map((d) => d.name)
          .sort(),
      ).toEqual(maintVisibleTools);
      // 危险业务工具 shell / write_file 在自维护会话中彻底不可见且被 guard 拦截
      expect(root.tools.executable('shell', maintAgent)).toBeUndefined();
      expect(root.tools.executable('write_file', maintAgent)).toBeUndefined();
      const guardDenial = root.tools.checkGuards({
        name: 'shell',
        agent: maintAgent,
      } as never);
      expect(guardDenial?.reason).toContain('forbids non-whitelisted tools');
      // 普通对话执行 shell 不被自维护 guard 拦截
      expect(
        root.tools.checkGuards({
          name: 'shell',
          agent: userAgent,
        } as never),
      ).toBeUndefined();
    } finally {
      offTools();
      await runtime.stop();
    }
  });

  it('当 sessionController.create 重分配新会话 ID 或冷恢复时，凭专属 sandboxDir cwd 仍同步施加工具沙盒限制；createDshNeedsPorts 正确挂载 Workspace、透传压缩 Token 数、过滤 subagent/归档会话并上抛回合错误', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'asi-needs-ports-'));
    tempDirs.push(storageRoot);

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    root.tools.setExecutor(new NativeToolExecutor(root));

    for (const name of ['env_state', 'env_detail', 'shell']) {
      root.tools.register(
        defineTool({
          name,
          description: `mock ${name}`,
          parameters: {},
          output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
          async execute() {
            return { ok: true };
          },
        }),
      );
    }

    const agentsList: Agent[] = [];
    const createdWorkspaces: { id: string; path: string; title?: string; sessionIds: string[] }[] = [];
    const cryInbox: { agentId: string; text: string }[] = [];
    let failTurn = false;

    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
    });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished' });
    root.provide('asiSense', createMockSenseService(undefined, storageRoot));
    root.provide('workspaceRegistry', {
      archivedSessionIds: [SessionId('archived-user')],
      create: async (path: string, title?: string) => {
        const ws = { id: 'ws-maint-1', path, title, sessionIds: [] as string[] };
        createdWorkspaces.push(ws);
        return ws;
      },
      list: () => createdWorkspaces,
    });
    root.provide('compaction', {
      compactNow: async () => ({ shadowedTokenCount: 42_500 }),
    });
    root.provide('sessionController', {
      create: async (req: { workspaceId?: string; cwd?: string; sessionId?: string }) => {
        // 故意忽略 requested sessionId，重分配全新 mintedId，并在返回前触发 agent/created！
        const mintedId = 'session-minted-by-dsh-999';
        const ws = createdWorkspaces.find((w) => w.id === req.workspaceId);
        ws?.sessionIds.push(mintedId);
        const agent = {
          id: SessionId(mintedId),
          status: 'idle' as const,
          session: { header: { cwd: ws?.path ?? req.cwd } },
          followup: () => {
            if (failTurn) {
              emitAgentEvent(root, agent as unknown as Agent, 'agent/error', {
                turn: 1,
                step: 1,
                error: new Error('provider boom'),
              });
            }
          },
          send: () => {},
          cancel: () => {},
          whenIdle: async () => {},
        } as unknown as Agent & { ctx: Context };
        (agent as { ctx: Context }).ctx = createScope(root, agent).ctx;
        agentsList.push(agent);
        emitAgentEvent(root, agent, 'agent/created', { source: 'startup' });
        return { sessionId: SessionId(mintedId) };
      },
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async (sid: string) => {
        const found = agentsList.find((a) => a.id === sid);
        return found ? { agent: found } : { error: new Error('not found') };
      },
    });

    // 注册 subagent、已归档会话、正常用户会话，以及不在 excludeSessionIds 中的历史/冷恢复内部沙盒与委托会话（置后以攻击 candidates.at(-1)）
    for (const spec of [
      { id: 'subagent-1', origin: 'subagent' as const, cwd: undefined, delegationDepth: undefined },
      { id: 'archived-user', origin: undefined, cwd: undefined, delegationDepth: undefined },
      { id: 'live-user-1', origin: undefined, cwd: undefined, delegationDepth: undefined },
      { id: 'asi-maint-stale-99', origin: undefined, cwd: undefined, delegationDepth: undefined },
      { id: 'minted-sandbox-old', origin: undefined, cwd: join(storageRoot, 'sandbox'), delegationDepth: undefined },
      { id: 'delegated-child-1', origin: undefined, cwd: undefined, delegationDepth: 1 },
    ]) {
      const a = {
        id: SessionId(spec.id),
        status: 'idle' as const,
        session: {
          header: {
            ...(spec.origin ? { origin: spec.origin } : {}),
            ...(spec.cwd ? { cwd: spec.cwd } : {}),
            ...(spec.delegationDepth !== undefined ? { delegationDepth: spec.delegationDepth } : {}),
          },
        },
        followup: (msg: { content: { text: string }[] }) =>
          cryInbox.push({ agentId: spec.id, text: msg.content[0]?.text ?? '' }),
        send: (msg: { content: { text: string }[] }) =>
          cryInbox.push({ agentId: spec.id, text: msg.content[0]?.text ?? '' }),
      } as unknown as Agent & { ctx: Context };
      (a as { ctx: Context }).ctx = createScope(root, a).ctx;
      agentsList.push(a);
    }

    const ports = createDshNeedsPorts(root, storageRoot);
    const runtime = createNeedsRuntime(ports);
    const offTools = registerNeedsTools(root, runtime);
    await runtime.start();

    try {
      // 1. 打开自维护会话：挂载到 Workspace 且即便 ID 被重分配为 session-minted-by-dsh-999，仍在 agent/created 瞬间被沙盒隔离
      const sid = await runtime.actions.openMaintenanceSession();
      expect(sid).toBe('session-minted-by-dsh-999');
      expect(createdWorkspaces).toHaveLength(1);
      expect(ports.sessions.hasSession(sid)).toBe(true);

      const mintedAgent = agentsList.find((a) => a.id === sid);
      expect(mintedAgent).toBeDefined();
      if (!mintedAgent) throw new Error('missing mintedAgent');
      expect(root.tools.executable('shell', mintedAgent)).toBeUndefined();
      expect(
        root.tools
          .definitions(mintedAgent)
          .map((d) => d.name)
          .sort(),
      ).toEqual(
        [
          'env_detail',
          'env_state',
          'needs_clean_cache',
          'needs_compact_context',
          'needs_request_help',
          'needs_sniff_causes',
          'needs_status',
          'needs_stop_job',
        ].sort(),
      );

      // 2. 空闲会话枚举与压缩：过滤 subagent、已归档会话与内部自维护会话，且正确透传 shadowedTokenCount
      const idleIds = ports.compaction.listIdleSessionIds(new Set([sid]));
      expect(idleIds).toEqual(['live-user-1']);
      const compRes = await ports.compaction.compactIdleSession('live-user-1', new AbortController().signal);
      expect(compRes).toEqual({ compacted: true, tokensSaved: 42_500 });

      // 3. 啼哭投递：若 target 为 subagent 则跳过，回退投递至真实普通用户会话 live-user-1
      const delivered = await ports.sessions.deliverCryToUserSession(
        'subagent-1',
        new Set([sid]),
        '<asi-cry>help</asi-cry>',
        'wakeup',
      );
      expect(delivered).toBe(true);
      expect(cryInbox).toEqual([{ agentId: 'live-user-1', text: '<asi-cry>help</asi-cry>' }]);

      // 4. 自维护回合报错时如实抛出异常而非静默当作成功
      failTurn = true;
      await expect(ports.sessions.runMaintenanceTurn(sid, 'check', new AbortController().signal)).rejects.toThrow(
        'provider boom',
      );
    } finally {
      offTools();
      await runtime.stop();
    }
  });
});
