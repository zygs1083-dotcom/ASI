import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService from '@deepseek-ai/dsh-tools';
import * as AsiNeedsPlugin from 'asi-needs';
import * as AsiSensePlugin from 'asi-sense';
import { afterEach, describe, expect, it } from 'vitest';
import * as AsiSleepPlugin from '../src/host/dsh/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

function appendTurn(session: Session, turn: number, userText: string, assistantText: string): void {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  session.append(
    'user/message',
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }),
    {
      surfaceOp: 'append',
    },
  );
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'mock', model: 'mock-1' },
        content: [{ type: 'text', text: assistantText }],
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  );
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

describe('Cordis 全栈联合集成（asi-sense + asi-needs + asi-sleep）', () => {
  it('L2 驱动接入 ctx.asiDrives 且聊天期间绝不提前拉起 ASI 自维护会话；严格跳过后台沙盒与 subagent 会话；memory_recall/memory_profile 零提示词注入且脱敏输出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-sleep-cordis-'));
    tempDirs.push(dir);

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    root.tools.setExecutor(new NativeToolExecutor(root));

    const agentsList: Agent[] = [];
    const sessionsList: Session[] = [];
    let maintSessionCreatedCount = 0;

    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
      withoutInitiator: <T>(fn: () => T) => fn(),
    });
    root.provide('jobs', {
      list: () => [],
      kill: () => 'already-finished',
      events: { subscribe: () => () => {} },
    });
    root.provide('llm', {
      listConfigurableProviders: () => [],
      resolveModelInfo: async () => undefined,
    });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('sessions', { list: () => sessionsList });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('profileContext', {
      name: 'fixture',
      dir,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: '',
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('sessionController', {
      create: async (req: { cwd?: string; sessionId?: string }) => {
        maintSessionCreatedCount += 1;
        const sid = SessionId(req.sessionId ?? `asi-maint-${maintSessionCreatedCount}`);
        const s = Session.create(sid, [], {
          version: 4,
          id: sid,
          createdAt: Date.now(),
          cwd: req.cwd ?? join(dir, 'needs', 'sandbox'),
          isSeeded: false,
        });
        sessionsList.push(s);
        const maintAgent = {
          id: sid,
          status: 'idle' as const,
          session: s,
          followup: () => {},
          send: () => {},
          cancel: () => {},
          whenIdle: async () => {},
        } as unknown as Agent & { ctx: Context };
        maintAgent.ctx = createScope(root, maintAgent).ctx;
        agentsList.push(maintAgent);
        emitAgentEvent(root, maintAgent, 'agent/created', { source: 'startup' });
        return { sessionId: sid };
      },
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async (sid: string) => {
        const found = agentsList.find((a) => a.id === sid);
        return found ? { agent: found } : { error: new Error('not found') };
      },
    });

    const senseFork = await root.plugin(AsiSensePlugin, {
      storageRoot: join(dir, 'sense'),
      helperPath: join(dir, 'nonexistent-helper'),
      intervalMs: 10_000,
    });
    const needsFork = await root.plugin(AsiNeedsPlugin, {
      storageRoot: join(dir, 'needs'),
    });
    const sleepFork = await root.plugin(AsiSleepPlugin, {
      storageRoot: join(dir, 'sleep'),
    });

    try {
      // 1. 准备三类会话：普通用户会话、subagent 子代理会话、后台自维护沙盒会话
      const userSession = Session.create(SessionId('user-chat-1'), [], {
        version: 4,
        id: SessionId('user-chat-1'),
        createdAt: Date.now(),
        cwd: join(dir, 'project'),
        isSeeded: false,
      });
      const subagentSession = Session.create(SessionId('subagent-worker-1'), [], {
        version: 4,
        id: SessionId('subagent-worker-1'),
        createdAt: Date.now(),
        cwd: join(dir, 'project'),
        origin: 'subagent',
        delegationDepth: 1,
        isSeeded: false,
      });
      const sandboxSession = Session.create(SessionId('asi-maint-manual'), [], {
        version: 4,
        id: SessionId('asi-maint-manual'),
        createdAt: Date.now(),
        cwd: join(dir, 'needs', 'sandbox'),
        isSeeded: false,
      });
      sessionsList.push(userSession, subagentSession, sandboxSession);

      const userAgent = {
        id: userSession.id,
        status: 'idle' as const,
        session: userSession,
      } as unknown as Agent & { ctx: Context };
      userAgent.ctx = createScope(root, userAgent).ctx;
      agentsList.push(userAgent);
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'startup' });

      // 校验 0 动态系统提示词污染（保护 Prompt Cache）
      const assembledPrompt = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      expect(assembledPrompt.sections.map((s) => s.name)).not.toContain('asi-sleep');
      expect(assembledPrompt.sections.map((s) => s.text).join('\n')).not.toContain('asi-sleep');

      // 在 subagent 和自维护沙盒各塞入 15 轮敏感特征对话 -> 必须被 100% 忽略，未整合轮次保持 0！
      for (let i = 1; i <= 15; i += 1) {
        appendTurn(subagentSession, i, `子代理偏好：统一使用 bun (${i})`, '子代理回复');
        appendTurn(sandboxSession, i, `沙盒决策：决定采用某内部清理策略 (${i})`, '沙盒回复');
      }
      await root.asiSense.refresh?.();
      const driveBefore = root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation');
      expect(driveBefore?.evidence.unconsolidatedTurns).toBe(0);
      expect(driveBefore?.satisfaction).toBe(100);

      // 2. 在普通用户会话写入 12 轮对话（含动态拼接的测试密钥）：产生 L2 睡眠不适 (<60)，但因未满 10m 静默窗口，绝不提前拉起 ASI 自维护会话！
      const fakeTok = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6'].join('_');
      for (let i = 1; i <= 12; i += 1) {
        appendTurn(
          userSession,
          i,
          i === 1
            ? `架构决策：决定采用 MiniSearch 作为记忆检索引擎，附临时 token ${fakeTok}`
            : `第 ${i} 轮开发进展讨论：完善 FSRS 保留率曲线。`,
          `第 ${i} 轮已完成实现与自测。`,
        );
      }
      root.asiDrives.notifySourceChanged('asi-sleep');
      await root.asiSense.refresh?.();
      await new Promise((r) => setTimeout(r, 40));

      const driveSleepy = root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation');
      expect(driveSleepy?.tier).toBe(2);
      expect(driveSleepy?.satisfaction).toBeLessThan(60);
      expect(driveSleepy?.zone).toBe('uncomfortable');
      // 关键断言：用户在聊天中（未满 10 分钟空闲），ASI 自维护会话创建次数必须为 0！
      expect(maintSessionCreatedCount).toBe(0);

      // 切换 eco 模式：L2 睡眠需求立即被压制挂起 (suppressed = true)
      await root.asiSense.setPowerMode('eco', '电池节能测试');
      expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation')?.suppressed).toBe(true);
      await root.asiSense.setPowerMode('normal');

      // 3. 通过 AsiSleepRemote（用户身份，无 principal）执行手动立即睡眠整合，随后验证普通对话调用 memory_recall 与 memory_profile
      const rec = await root.asiSleep.consolidateNow();
      expect(rec.turnsProcessed).toBe(12);
      expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation')?.satisfaction).toBe(100);

      const userToolNames = root.tools.definitions(userAgent).map((d) => d.name);
      expect(userToolNames).toContain('memory_recall');
      expect(userToolNames).toContain('memory_profile');
      expect(userToolNames).not.toContain('sleep_consolidate');

      const recallExec = root.tools.executable('memory_recall', userAgent);
      const profileExec = root.tools.executable('memory_profile', userAgent);
      expect(recallExec).toBeDefined();
      expect(profileExec).toBeDefined();

      const recallOut = (await recallExec?.execute({ query: 'MiniSearch 检索引擎' }, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'c1' as never,
      } as never)) as { hits: Array<{ title: string; content: string; recallCount: number }> };

      expect(recallOut.hits.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(recallOut)).not.toContain(fakeTok);
      expect(recallOut.hits.some((h) => !h.content.includes('bun'))).toBe(true);
      expect(recallOut.hits[0]?.recallCount).toBe(1);

      const profileOut = (await profileExec?.execute({}, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'c2' as never,
      } as never)) as { totalMemories: number };
      expect(profileOut.totalMemories).toBeGreaterThanOrEqual(2);

      await expect(
        recallExec?.execute({ query: '   ' }, {
          agent: userAgent,
          signal: new AbortController().signal,
          callId: 'c3' as never,
        } as never),
      ).rejects.toThrow(/non-empty/);
      await expect(
        recallExec?.execute({ query: 'x'.repeat(9_000) }, {
          agent: userAgent,
          signal: new AbortController().signal,
          callId: 'c4' as never,
        } as never),
      ).rejects.toThrow(/8192/);
      await expect(
        profileExec?.execute({ kind: 'bad-kind' as never }, {
          agent: userAgent,
          signal: new AbortController().signal,
          callId: 'c5' as never,
        } as never),
      ).rejects.toThrow(/must be one of|invalid memory kind/);

      const sandboxCaller = {
        id: sandboxSession.id,
        status: 'idle' as const,
        session: sandboxSession,
      } as unknown as Agent;
      const sandboxRecall = (await recallExec?.execute({ query: 'MiniSearch 检索引擎' }, {
        agent: sandboxCaller,
        signal: new AbortController().signal,
        callId: 'c6' as never,
      } as never)) as { hits: Array<{ recallCount: number }> };
      expect(sandboxRecall.hits[0]?.recallCount).toBe(1);
    } finally {
      sleepFork.dispose();
      needsFork.dispose();
      senseFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});
