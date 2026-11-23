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
import {
  createMaintenanceActionTools,
  MAINTENANCE_ACTION_TOOL_NAMES,
  registerNeedsTools,
} from '../src/host/dsh/tools.js';
import { createNeedsRuntime } from '../src/host/runtime.js';
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
});
