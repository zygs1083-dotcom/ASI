import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AsiDrivesServiceApi,
  AsiDrivesSnapshot,
  AsiSenseServiceApi,
  DriveSourceRegistration,
  SenseSnapshot,
  SleepMemorySummary,
} from '@asi/sense-types';
import { makeScenario } from '@asi/sense-ui';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService from '@deepseek-ai/dsh-tools';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AsiPanel } from '../../src/client/AsiPanel.tsx';
import { createDreamRuntime } from '../../src/dream/host/runtime.ts';
import { DreamVault } from '../../src/dream/host/vault.ts';
import * as AsiPlugin from '../../src/host/dsh/index.ts';

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
    { surfaceOp: 'append' },
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

describe('DreamVault 安全护栏、马斯洛 15m 深静默抢占与 AsiPlugin 全栈闭环验证', () => {
  it('DreamVault 原子持久化 insights.jsonl 与 INSIGHTS.md，自动脱敏凭据并拦截符号链接覆盖攻击', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-dream-vault-'));
    tempDirs.push(dir);

    const vault = new DreamVault(join(dir, 'dream'), dir);
    await vault.load();

    const leakedSecret = ['sk', '-', '9aB8cD7eF6gH5iJ4kL3mN2oP1qR0sT'].join('');
    vault.upsert({
      id: 'ins_sec_1',
      kind: 'preventive-warning',
      status: 'open',
      title: `跨仓安全测试 ${leakedSecret}`,
      summary: `来自 ${dir}/repo-a 的落盘路径与密钥 ${leakedSecret} 均须脱敏`,
      bridgeMechanism: '符号链接与脱敏测试',
      actionableHypothesis: '执行原子写保护',
      repoKeys: ['repo-a#11', 'repo-b#22'],
      sourceRepos: [`${dir}/repo-a`, `${dir}/repo-b`],
      sourceMemoryIds: ['m1'],
      sourceSessionIds: ['s1'],
      tags: ['security'],
      topicKey: 'dmn:sec',
      pairSignature: 'repo-a#11|repo-b#22::preventive-warning::dmn:sec',
      noveltyScore: 0.8,
      structuralSimilarity: 0.75,
      confidence: 0.85,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    });
    await vault.flush();

    const mdText = await readFile(join(dir, 'dream', 'vault', 'INSIGHTS.md'), 'utf8');
    expect(mdText).not.toContain(leakedSecret);
    expect(mdText).toContain('~/repo-a');

    const reloaded = new DreamVault(join(dir, 'dream'), dir);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.sourceRepos).toEqual(['~/repo-a', '~/repo-b']);

    // 符号链接攻击：若 vault 目录被替换为 symlink，load 必须拒绝
    const evilDir = join(dir, 'evil');
    await mkdir(evilDir, { recursive: true });
    const symRoot = join(dir, 'sym-dream');
    await mkdir(symRoot, { recursive: true });
    await symlink(evilDir, join(symRoot, 'vault'));
    const attacked = new DreamVault(symRoot, dir);
    await expect(attacked.load()).rejects.toThrow(/symlink/i);
  });

  it('在途自动做梦遇 L1 生理告警或用户新活动立即 AbortSignal 抢占中断并回滚当日自动配额', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-dream-preempt-'));
    tempDirs.push(dir);
    const repo1 = join(dir, 'r1');
    const repo2 = join(dir, 'r2');
    await mkdir(join(repo1, '.git'), { recursive: true });
    await mkdir(join(repo2, '.git'), { recursive: true });
    await writeFile(join(repo1, 'package.json'), '{"dependencies":{"better-sqlite3":"1.0.0"}}');
    await writeFile(join(repo2, 'package.json'), '{"dependencies":{"better-sqlite3":"1.0.0"}}');

    let wallNow = 1_760_000_000_000;
    let monoNow = 10_000;
    const baseScenario = makeScenario('healthy');
    let currentSense: SenseSnapshot = {
      now: wallNow,
      mono: monoNow,
      state: baseScenario.state as unknown as SenseSnapshot['state'],
      history: baseScenario.history,
      settings: { paused: false, sendTitles: true, powerMode: 'normal' },
      sampleIntervalsMs: {},
    };
    const senseListeners = new Set<(s: SenseSnapshot) => void>();
    const drivesListeners = new Set<(s: AsiDrivesSnapshot) => void>();
    let higherSuppressed = false;
    let registeredSource: DriveSourceRegistration | undefined;

    const mockSense: AsiSenseServiceApi = {
      snapshot: () => currentSense,
      subscribe: (fn) => {
        senseListeners.add(fn);
        return () => senseListeners.delete(fn);
      },
      getSettings: () => currentSense.settings,
      setPaused: async () => {},
      setSendTitles: async () => {},
      setPowerMode: async () => {},
      openPermissionSettings: async () => {},
      registerInternalSession: () => () => {},
      recentSignals: () => [],
    };

    const buildDrivesSnap = (): AsiDrivesSnapshot => ({
      now: wallNow,
      powerMode: currentSense.settings.powerMode,
      higherOrderSuppressed: higherSuppressed,
      ...(higherSuppressed ? { suppressionReason: 'L1 生理危急' } : {}),
      activeTier: higherSuppressed ? 1 : null,
      drives: [],
    });

    const mockDrives: AsiDrivesServiceApi = {
      snapshot: buildDrivesSnap,
      subscribe: (fn) => {
        drivesListeners.add(fn);
        return () => drivesListeners.delete(fn);
      },
      registerSource: (reg) => {
        registeredSource = reg;
        return () => {
          registeredSource = undefined;
        };
      },
      notifySourceChanged: () => {},
    };

    let llmStartedResolve: (() => void) | undefined;
    const llmStarted = new Promise<void>((res) => {
      llmStartedResolve = res;
    });
    let abortedObserved = false;

    const mem: SleepMemorySummary = {
      id: 'm_wal',
      kind: 'pitfall',
      title: 'SQLite 锁表死锁需设 busy_timeout',
      content: '并发写必须开启 busy_timeout 并使用原子写。',
      tags: ['sqlite'],
      pinned: true,
      confidence: 0.95,
      retention: 1,
      evidenceCount: 2,
      recallCount: 1,
      sourceSessionIds: ['s1'],
      createdAt: wallNow - 60_000,
      updatedAt: wallNow - 60_000,
    };

    const rt = createDreamRuntime({
      storageRoot: join(dir, 'dream-data'),
      homeDir: dir,
      clock: { wall: () => wallNow, mono: () => monoNow },
      sense: mockSense,
      drives: mockDrives,
      getSleep: () => ({ listMemories: () => [mem], subscribe: () => () => {} }),
      conversations: {
        listCompletedOrdinaryTurns: () => [
          {
            turnId: 's2:t1',
            sessionId: 's2',
            cwd: repo2,
            at: wallNow - 30_000,
            userText: '排查 SQLite 锁表超时死锁',
            assistantText: '检查连接配置',
            toolNames: [],
            failedToolCount: 1,
          },
        ],
        anyOrdinarySessionRunning: () => false,
        listKnownWorkspaces: () => [repo1, repo2],
        listSessionWorkspaces: () =>
          new Map([
            ['s1', repo1],
            ['s2', repo2],
          ]),
        onOrdinaryActivity: () => () => {},
      },
      llmDream: async (_prompt, signal) => {
        llmStartedResolve?.();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              abortedObserved = true;
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
        return undefined;
      },
    });

    await rt.start();
    try {
      expect(registeredSource?.tier).toBe(4);
      expect(rt.panelModel().drive.readyToDream).toBe(true);
      expect(rt.panelModel().drive.autoDreamsToday).toBe(0);

      // 推进时间满 16 分钟进入深静默，触发自动做梦
      wallNow += 16 * 60_000;
      monoNow += 16 * 60_000;
      currentSense = { ...currentSense, now: wallNow, mono: monoNow };
      for (const fn of senseListeners) fn(currentSense);

      await llmStarted;
      expect(rt.panelModel().dreaming).toBe(true);

      // 在途突发 L1 生理压制：必须立即中断且自动配额回滚为 0！
      higherSuppressed = true;
      for (const fn of drivesListeners) fn(buildDrivesSnap());
      await new Promise((r) => setTimeout(r, 30));

      expect(abortedObserved).toBe(true);
      expect(rt.panelModel().dreaming).toBe(false);
      expect(rt.panelModel().drive.autoDreamsToday).toBe(0);
      expect(rt.panelModel().totalInsights).toBe(0);
    } finally {
      await rt.stop();
    }
  });

  it('全栈挂载 AsiPlugin：暴露 ctx.asiDream 与 dream_insights 只读工具（零动态提示词注入），支持采纳为记忆、转交技能草案与侧栏渲染', {
    timeout: 30_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-dream-full-cordis-'));
    tempDirs.push(rootDir);
    const repoAlpha = join(rootDir, 'work', 'alpha-service');
    const repoBeta = join(rootDir, 'work', 'beta-worker');
    await mkdir(join(repoAlpha, '.git'), { recursive: true });
    await mkdir(join(repoBeta, '.git'), { recursive: true });
    await writeFile(
      join(repoAlpha, 'package.json'),
      JSON.stringify({ dependencies: { 'better-sqlite3': '1.0.0' }, devDependencies: { typescript: '5.0.0' } }),
    );
    await writeFile(
      join(repoBeta, 'package.json'),
      JSON.stringify({ dependencies: { 'better-sqlite3': '1.0.0' }, devDependencies: { typescript: '5.0.0' } }),
    );

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    await root.plugin(SessionStore);
    await root.plugin(SkillRegistry);
    root.tools.setExecutor(new NativeToolExecutor(root));

    const sessAlpha = root.sessions.create(SessionId('sess-alpha'), {
      meta: { cwd: repoAlpha, isSeeded: false },
    });
    const sessBeta = root.sessions.create(SessionId('sess-beta'), {
      meta: { cwd: repoBeta, isSeeded: false },
    });
    appendTurn(
      sessAlpha,
      1,
      '记录一个踩坑：SQLite 并发写报错锁表',
      '根因是未配置 busy_timeout，修复方案是开启 busy_timeout 并采用临时文件原子写防止死锁。',
    );
    appendTurn(
      sessBeta,
      1,
      '排查 beta-worker 高并发写入 SQLite 锁表 race condition 超时失败',
      '正在定位写入连接锁竞争。',
    );

    const agentBeta = {
      id: sessBeta.id,
      status: 'idle' as const,
      session: sessBeta,
    } as unknown as Agent & { ctx: Context };
    agentBeta.ctx = createScope(root, agentBeta).ctx;

    root.provide('agents', {
      list: () => [agentBeta],
      get: (id: string) => (id === agentBeta.id ? agentBeta : undefined),
      withoutInitiator: <T>(fn: () => T) => fn(),
    });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [],
      create: async () => ({}),
      list: () => [
        { id: 'ws-a', path: repoAlpha, sessionIds: [sessAlpha.id] },
        { id: 'ws-b', path: repoBeta, sessionIds: [sessBeta.id] },
      ],
    });
    root.provide('profileContext', {
      name: 'desktop',
      dir: rootDir,
      patchPath: '',
      installAnchor: '',
      cwd: repoBeta,
      home: rootDir,
      startedBundles: ['asi'],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });

    const asiFork = await root.plugin(AsiPlugin, {
      storageRoot: join(rootDir, 'data', 'asi'),
      helperPath: join(rootDir, 'nonexistent-helper'),
      intervalMs: 15_000,
    });

    try {
      await asiFork.await();
      emitAgentEvent(root, agentBeta, 'agent/created', { source: 'startup' });

      // 1. 先执行 L2 睡眠整合沉淀 Alpha 的踩坑记忆，再触发 DMN 跨项目做梦联想
      await root.asi.consolidateNow();
      const dreamRec = await root.asi.dreamNow();
      expect(dreamRec.reposScanned).toBe(2);
      expect(dreamRec.insightsCreated).toBeGreaterThanOrEqual(1);
      expect(root.asiDream.listInsights({ statuses: ['open'] }).length).toBeGreaterThanOrEqual(1);

      // 2. 验证零动态提示词注入（100% 保护 Prompt Cache）且仅暴露只读工具 dream_insights
      const assembled = await root.systemPrompt.assemble({ agent: agentBeta, scope: agentBeta });
      expect(assembled.sections.map((s) => s.name)).not.toContain('asi');
      expect(assembled.sections.map((s) => s.name)).not.toContain('asi-dream');

      const toolNames = root.tools.definitions(agentBeta).map((d) => d.name);
      expect(toolNames).toContain('dream_insights');
      expect(toolNames).not.toContain('dream_synthesize_cross_repo');

      const dreamExec = root.tools.executable('dream_insights', agentBeta);
      expect(dreamExec).toBeDefined();
      const parsedToolOut = (await dreamExec?.execute({ forCurrentWorkspace: true }, {
        agent: agentBeta,
        signal: new AbortController().signal,
        callId: 'call_dream_1' as never,
      } as never)) as { insights?: Array<{ id: string; targetRepo?: string }> };
      expect(parsedToolOut.insights?.length).toBeGreaterThanOrEqual(1);
      expect(parsedToolOut.insights?.[0]?.targetRepo).toBe('~/work/beta-worker');

      // 3. 验证统一帧流携带 dream 快照且 AsiPanel SSR 正常渲染跨 Tab 待批焦点条
      const abort = new AbortController();
      const iter = root.asi.frames(abort.signal)[Symbol.asyncIterator]();
      const firstFrame = await iter.next();
      expect(firstFrame.value?.dream?.openCount).toBeGreaterThanOrEqual(1);

      const html = renderToStaticMarkup(
        h(AsiPanel, {
          model: firstFrame.value as Parameters<typeof AsiPanel>[0]['model'],
          initialTab: 'care',
          onPause: async () => {},
          onToggleTitles: async () => {},
          onOpenPermissionSettings: async () => {},
          onApproveHelp: async () => {},
          onDismissHelp: async () => {},
          onOpenMaintenanceSession: async () => {},
          onTriggerCheck: async () => {},
          onConsolidateNow: async () => undefined,
          onToggleAutoSleepPaused: async () => {},
          onCreateMemory: async () => undefined,
          onUpdateMemory: async () => undefined,
          onTogglePin: async () => undefined,
          onDeleteMemory: async () => {},
          onSynthesizeNow: async () => undefined,
          onToggleAutoGrowthPaused: async () => {},
          onCreateManualDraft: async () => undefined,
          onUpdateDraft: async () => undefined,
          onApproveDraft: async () => undefined,
          onRejectDraft: async () => {},
          onUpdateSkill: async () => undefined,
          onSetSkillScope: async () => undefined,
          onSetSkillEnabled: async () => undefined,
          onArchiveSkill: async () => undefined,
          onRestoreSkill: async () => undefined,
          onDeleteArchivedSkill: async () => {},
          onExportSkillToWorkspace: async () => undefined,
          onAdoptDreamInsight: async () => undefined,
        }),
      );
      expect(html).toContain('spotlight-insight-banner');
      expect(html).toContain('跨项目新顿悟');
      abort.abort();

      // 4. 验证闭环动作：转交技能草案 -> 批准热挂载至 root.skills；以及采纳为长期记忆
      const firstOpen = root.asiDream.listInsights({ statuses: ['open'] })[0];
      expect(firstOpen).toBeDefined();
      const targetId = firstOpen?.id ?? '';
      const promoted = await root.asi.promoteDreamInsight(targetId);
      expect(promoted.insight.status).toBe('promoted');
      const approvedSkill = await root.asi.approveDraft(promoted.draftId);
      expect(approvedSkill.status).toBe('active');
      expect((await root.skills.list({ cwd: repoBeta })).map((s) => s.name)).toContain(promoted.skillName);

      const adopted = await root.asi.adoptDreamInsight({ insightId: targetId, pinned: true });
      expect(adopted.insight.status).toBe('adopted');
      expect(root.asiSleep.listMemories({ limit: 50 }).some((m) => m.id === adopted.memoryId)).toBe(true);
    } finally {
      asiFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});
