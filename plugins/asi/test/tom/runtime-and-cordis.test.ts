import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService from '@deepseek-ai/dsh-tools';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TomCapsuleBadge, TomCard } from '../../src/client/TomCard.tsx';
import * as AsiPlugin from '../../src/host/dsh/index.ts';
import { AsiDrivesService } from '../../src/needs/host/dsh/drives-service.ts';
import { createNeedsRuntime } from '../../src/needs/host/runtime.ts';
import { createTomRuntime, type PartnerToolReport } from '../../src/tom/host/runtime.ts';
import { createMockSenseService } from '../needs/fixtures.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

describe('方向 B · ToM 全栈 Cordis 集成、100% Prompt Cache 恒定保护与静默仲裁验证', () => {
  it('暴露 ctx.asiTom 与 partner_state 工具：跨状态跃迁时 systemPrompt 100% 字节恒定，高摩擦驱动绝不唤醒后台 LLM，且记忆偏好全链路脱敏', {
    timeout: 45_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-tom-cordis-'));
    tempDirs.push(rootDir);

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    await root.plugin(SessionStore);
    await root.plugin(SkillRegistry);
    root.tools.setExecutor(new NativeToolExecutor(root));

    const chatSession = root.sessions.create(SessionId('sess-partner-1'), {
      meta: { cwd: rootDir, isSeeded: false },
    });
    const userAgent = {
      id: chatSession.id,
      status: 'idle' as const,
      session: chatSession,
    } as unknown as Agent & { ctx: Context };
    userAgent.ctx = createScope(root, userAgent).ctx;

    const subagentSession = root.sessions.create(SessionId('sess-subagent-1'), {
      meta: { cwd: rootDir, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    });
    const subAgent = {
      id: subagentSession.id,
      status: 'idle' as const,
      session: subagentSession,
    } as unknown as Agent & { ctx: Context };
    subAgent.ctx = createScope(root, subAgent).ctx;

    const maintSession = root.sessions.create(SessionId('asi-maint-probe-1'), {
      meta: { cwd: join(rootDir, 'data', 'asi', 'needs', 'sandbox'), isSeeded: false },
    });
    const maintAgent = {
      id: maintSession.id,
      status: 'idle' as const,
      session: maintSession,
    } as unknown as Agent & { ctx: Context };
    maintAgent.ctx = createScope(root, maintAgent).ctx;

    const secondChatSession = root.sessions.create(SessionId('sess-partner-2'), {
      meta: { cwd: rootDir, isSeeded: false },
    });
    const secondUserAgent = {
      id: secondChatSession.id,
      status: 'idle' as const,
      session: secondChatSession,
    } as unknown as Agent & { ctx: Context };
    secondUserAgent.ctx = createScope(root, secondUserAgent).ctx;

    const archivedSessionIds: string[] = [];
    const createMaintSpy = vi.fn(async () => ({ sessionId: SessionId('asi-maint-should-not-run') }));

    root.provide('agents', {
      list: () => [userAgent, subAgent, maintAgent, secondUserAgent],
      get: (id: string) => [userAgent, subAgent, maintAgent, secondUserAgent].find((a) => a.id === id),
      withoutInitiator: <T>(fn: () => T) => fn(),
    });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('workspaceRegistry', {
      get archivedSessionIds() {
        return archivedSessionIds;
      },
      create: async () => ({}),
      list: () => [{ id: 'ws-1', path: rootDir, sessionIds: [chatSession.id, secondChatSession.id] }],
    });
    root.provide('profileContext', {
      name: 'desktop',
      dir: rootDir,
      patchPath: '',
      installAnchor: '',
      cwd: rootDir,
      home: rootDir,
      startedBundles: ['asi'],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('sessionController', {
      create: createMaintSpy,
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async () => ({ error: new Error('none') }),
    });

    const asiFork = await root.plugin(AsiPlugin, {
      storageRoot: join(rootDir, 'data', 'asi'),
      helperPath: join(rootDir, 'nonexistent-helper'),
      intervalMs: 15_000,
      fastIntervalMs: 60_000,
      slowIntervalMs: 120_000,
    });

    try {
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'startup' });
      await new Promise((r) => setTimeout(r, 40));

      expect(root.asiTom).toBeDefined();
      const promptBefore = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      const tomSectionBefore = promptBefore.sections.find((s) => s.name === 'asi-tom');
      expect(tomSectionBefore).toBeDefined();
      expect(tomSectionBefore?.text.length).toBeGreaterThan(20);

      // 两个不同普通会话共享 100% 恒定字节提示词；asi-maint-* 与 subagent 自动隔离返回空串，渲染后零 partner_state 引导
      const promptSecondUser = await root.systemPrompt.assemble({ agent: secondUserAgent, scope: secondUserAgent });
      expect(promptSecondUser.sections.find((s) => s.name === 'asi-tom')?.text).toBe(tomSectionBefore?.text);
      const promptMaint = await root.systemPrompt.assemble({ agent: maintAgent, scope: maintAgent });
      const promptSub = await root.systemPrompt.assemble({ agent: subAgent, scope: subAgent });
      expect(promptMaint.sections.find((s) => s.name === 'asi-tom')?.text).toBe('');
      expect(promptSub.sections.find((s) => s.name === 'asi-tom')?.text).toBe('');
      expect(renderPrompt(promptMaint)).not.toContain('partner_state');
      expect(renderPrompt(promptSub)).not.toContain('partner_state');

      // 注入一条含敏感 token 的长期协作偏好记忆，验证 partner_state 会联动读取并彻底打码
      const fakeKey = `${['sk', '-'].join('')}${'a9'.repeat(15)}`;
      await root.asi.createMemory({
        kind: 'preference',
        title: '代码风格精炼偏好',
        content: `搭档喜欢直接给 diff，测试凭据样本 ${fakeKey} 不得泄漏。`,
        pinned: true,
      });

      // 模拟搭档连续遇到中断与失败回合 -> 状态跃迁至 stuck_debugging
      for (let t = 1; t <= 2; t += 1) {
        chatSession.append('turn/start', { turn: t });
        chatSession.append(
          'user/message',
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '不对，停一下看报错' }] }),
          { surfaceOp: 'append' },
        );
        chatSession.append(
          'assistant/message',
          {
            turn: t,
            step: 1,
            interrupted: true,
            message: createAssistantMessage({
              source: { provider: 'mock', model: 'mock-1' },
              content: [{ type: 'text', text: '正在尝试...' }],
            }),
            stream: [],
          },
          { surfaceOp: 'append' },
        );
        chatSession.append('turn/end', { turn: t, reason: { kind: 'interrupted' } });
      }

      await new Promise((r) => setTimeout(r, 30));
      const snapAfterInterrupt = root.asiTom.snapshot();
      expect(snapAfterInterrupt.state).toBe('stuck_debugging');
      expect(snapAfterInterrupt.dimensions.friction).toBeGreaterThanOrEqual(55);
      expect(snapAfterInterrupt.guidance.autonomy).toBe('verify_first');

      // 马斯洛仲裁器中 asi-tom:social_tact 显示为 uncomfortable，且标记 autoMaintain=false
      const socialDrive = root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-tom:social_tact');
      expect(socialDrive).toBeDefined();
      expect(socialDrive?.zone).toBe('uncomfortable');
      expect(socialDrive?.autoMaintain).toBe(false);

      // Prompt Cache 铁律断言：即使搭档状态剧烈跃迁，systemPrompt 组装结果仍然 100% 字节恒定！
      const promptAfterStuck = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      expect(promptAfterStuck.sections).toEqual(promptBefore.sections);

      // 调用只读工具 partner_state，验证返回处方、基线与已脱敏偏好记忆
      const partnerTool = root.tools.executable('partner_state', userAgent);
      expect(partnerTool).toBeDefined();
      const toolOut = (await partnerTool?.execute({ includePreferences: true, includeBaseline: true }, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'call_tom_1' as never,
      } as never)) as unknown as PartnerToolReport;

      expect(toolOut.state).toBe('stuck_debugging');
      expect(toolOut.baseline?.sampleCount).toBe(2);
      expect(toolOut.consolidatedPreferences?.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(toolOut)).not.toContain(fakeKey);
      expect(JSON.stringify(toolOut)).toContain('[redacted]');

      // 子代理、内部自维护会话与已归档会话调用 partner_state 均被严格拒绝
      await expect(
        partnerTool?.execute({}, {
          agent: subAgent,
          signal: new AbortController().signal,
          callId: 'call_sub' as never,
        } as never),
      ).rejects.toThrow(/restricted to ordinary user sessions/);
      await expect(
        partnerTool?.execute({}, {
          agent: maintAgent,
          signal: new AbortController().signal,
          callId: 'call_maint' as never,
        } as never),
      ).rejects.toThrow(/restricted to ordinary user sessions/);
      // 仅传 scope 不传 agent 时（如诊断组装），asi-maint-* 与 subagent 同样被隔离为空串
      const scopeOnlyMaint = await root.systemPrompt.assemble({ scope: maintAgent });
      const scopeOnlySub = await root.systemPrompt.assemble({ scope: subAgent });
      expect(scopeOnlyMaint.sections.find((s) => s.name === 'asi-tom')?.text).toBe('');
      expect(scopeOnlySub.sections.find((s) => s.name === 'asi-tom')?.text).toBe('');

      archivedSessionIds.push(String(secondChatSession.id));
      // 即使会话被标记归档，其静态 systemPrompt 依然与普通会话 100% 字节恒定（不破坏归档恢复后的 Prompt Cache），
      // 而实时工具调用 partner_state 与 growth_status 均严格拦截已归档会话！
      const promptWhileArchived = await root.systemPrompt.assemble({ agent: secondUserAgent, scope: secondUserAgent });
      expect(promptWhileArchived.sections.find((s) => s.name === 'asi-tom')?.text).toBe(tomSectionBefore?.text);
      await expect(
        partnerTool?.execute({}, {
          agent: secondUserAgent,
          signal: new AbortController().signal,
          callId: 'call_archived' as never,
        } as never),
      ).rejects.toThrow(/restricted to ordinary user sessions/);
      const growthTool = root.tools.executable('growth_status', secondUserAgent);
      await expect(
        growthTool?.execute({}, {
          agent: secondUserAgent,
          signal: new AbortController().signal,
          callId: 'call_growth_archived' as never,
        } as never),
      ).rejects.toThrow(/restricted to ordinary user sessions/);
      archivedSessionIds.length = 0;

      // 全局暂停感知期间，ToM 严格冻结信号摄入与 EWMA 基线更新
      await root.asiSense.setPaused(true);
      const sampleCountBeforePause = root.asiTom.snapshot().baseline.sampleCount;
      chatSession.append('turn/start', { turn: 3 });
      chatSession.append(
        'user/message',
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '暂停期间测试消息' }] }),
        { surfaceOp: 'append' },
      );
      chatSession.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
      await new Promise((r) => setTimeout(r, 25));
      expect(root.asiTom.snapshot().baseline.sampleCount).toBe(sampleCountBeforePause);
      await root.asiSense.setPaused(false);

      // 通过 AsiRemote RPC 一键校准锁定为 deep_focus -> 验证 shouldDeferProactiveWork() 与实时帧同步
      const overriddenModel = await root.asi.setPartnerOverride({ state: 'deep_focus', durationMinutes: 45 });
      expect(overriddenModel.state).toBe('deep_focus');
      expect(overriddenModel.source).toBe('manual_override');
      expect(overriddenModel.baseline.calibrationCount).toBe(1);
      expect(root.asiTom.shouldDeferProactiveWork()).toBe(true);

      // 再次校验手动覆写后 systemPrompt 依然 0 字节变动
      const promptAfterOverride = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      expect(promptAfterOverride.sections).toEqual(promptBefore.sections);

      // 验证客户端独立组件 TomCapsuleBadge 与 TomCard 静态渲染语义完整
      const badgeHtml = renderToStaticMarkup(h(TomCapsuleBadge, { tom: overriddenModel, onSelectCareTab: () => {} }));
      expect(badgeHtml).toContain('搭档·心流');

      const cardHtml = renderToStaticMarkup(
        h(TomCard, {
          tom: overriddenModel,
          onSetTomEnabled: () => {},
          onSetPartnerOverride: () => {},
          onResetTomBaseline: () => {},
        }),
      );
      expect(cardHtml).toContain('搭档状态与协作眼力见');
      expect(cardHtml).toContain('手动锁定 · 深度心流');

      // 重置基线与关闭开关验证
      const resetModel = await root.asi.resetTomBaseline();
      expect(resetModel.source).toBe('inferred');
      expect(resetModel.baseline.calibrationCount).toBe(0);

      await root.asi.setTomEnabled(false);
      expect(root.asiTom.snapshot().enabled).toBe(false);
      expect(root.asiTom.shouldDeferProactiveWork()).toBe(false);
    } finally {
      await new Promise((r) => setTimeout(r, 80));
      asiFork.dispose();
      await new Promise((r) => setTimeout(r, 40));
    }
  });

  it('受控稳态隔离验证：当 L1 全部健康且仅 asi-tom:social_tact 处于高摩擦激活态时，零次唤醒后台自维护 LLM 会话且零 <asi-cry>', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-tom-silent-arb-'));
    tempDirs.push(rootDir);

    const root = new Context();
    const sense = createMockSenseService();
    const createMaintenanceSession = vi.fn(async (id: string) => id);
    const runMaintenanceTurn = vi.fn(async () => {});
    const deliverCryToUserSession = vi.fn(async () => true);

    const needsRuntime = createNeedsRuntime({
      storageRoot: join(rootDir, 'needs'),
      sense,
      jobs: { listActiveJobs: () => [], hasLiveOwner: () => true, killJob: () => 'already-finished' },
      compaction: { listIdleSessionIds: () => [], compactIdleSession: async () => ({ compacted: false }) },
      sessions: {
        createMaintenanceSession,
        hasSession: () => false,
        runMaintenanceTurn,
        deliverCryToUserSession,
      },
      probeEndpoint: async () => true,
    });
    await needsRuntime.start();
    const drivesService = new AsiDrivesService(root, needsRuntime);

    let turnCb: ((sig: { sessionId: string; at: number; outcome: 'interrupted' }) => void) | undefined;
    const tomRuntime = createTomRuntime({
      storageRoot: join(rootDir, 'tom'),
      sense,
      drives: drivesService,
      sessions: {
        hasActiveOrdinarySession: () => true,
        onUserPrompt: () => () => {},
        onTurnSettled: (cb) => {
          turnCb = cb;
          return () => {};
        },
        onApprovalResolved: () => () => {},
      },
    });
    await tomRuntime.start();

    try {
      const now = Date.now();
      turnCb?.({ sessionId: 'sess-1', at: now - 5_000, outcome: 'interrupted' });
      turnCb?.({ sessionId: 'sess-1', at: now - 1_000, outcome: 'interrupted' });
      await new Promise((r) => setTimeout(r, 40));

      const drive = drivesService.snapshot().drives.find((d) => d.key === 'asi-tom:social_tact');
      expect(drive?.zone).toBe('uncomfortable');
      expect(drive?.driveActive).toBe(true);
      expect(drive?.autoMaintain).toBe(false);

      expect(createMaintenanceSession).not.toHaveBeenCalled();
      expect(runMaintenanceTurn).not.toHaveBeenCalled();
      expect(deliverCryToUserSession).not.toHaveBeenCalled();

      // 当传感器进入节能模式 (eco) 时，L3 社交协作驱动自动被压制挂起
      await sense.setPowerMode('eco', 'test-eco');
      sense.emit({});
      await new Promise((r) => setTimeout(r, 20));
      expect(drivesService.snapshot().drives.find((d) => d.key === 'asi-tom:social_tact')?.suppressed).toBe(true);
    } finally {
      await tomRuntime.stop();
      await needsRuntime.stop();
    }
  });
});
