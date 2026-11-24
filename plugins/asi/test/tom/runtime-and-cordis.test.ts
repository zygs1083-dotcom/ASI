import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
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
    timeout: 30_000,
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

    const createMaintSpy = vi.fn(async () => ({ sessionId: SessionId('asi-maint-should-not-run') }));

    root.provide('agents', {
      list: () => [userAgent, subAgent],
      get: (id: string) => [userAgent, subAgent].find((a) => a.id === id),
      withoutInitiator: <T>(fn: () => T) => fn(),
    });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [],
      create: async () => ({}),
      list: () => [{ id: 'ws-1', path: rootDir, sessionIds: [chatSession.id] }],
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

      // 子代理会话调用 partner_state 被严格拒绝
      await expect(
        partnerTool?.execute({}, {
          agent: subAgent,
          signal: new AbortController().signal,
          callId: 'call_sub' as never,
        } as never),
      ).rejects.toThrow(/restricted to ordinary user sessions/);

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
