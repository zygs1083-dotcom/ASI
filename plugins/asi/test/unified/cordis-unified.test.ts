import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSkillMarkdown } from '../../src/growth/shared/skill-spec.ts';
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

describe('统一单插件 asi (0.6.0) 全栈 Cordis 集成与旧版数据零重跑迁移验证', () => {
  it('单次挂载 AsiPlugin 自动迁移 76 条记忆 + 水位线（不重复整合旧会话）+ 已启用技能，暴露全套 Cordis 服务、7 个只读工具与统一 AsiRemote 流', {
    timeout: 30_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-unified-cordis-'));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, 'data');
    const wsProject = join(rootDir, 'work', 'demo-project');
    await mkdir(wsProject, { recursive: true });

    // 1. 预置旧版 ../asi-sense 与 ../asi-sleep（含 76 条记忆与已整合水位线）
    await mkdir(join(dataDir, 'asi-sense'), { recursive: true });
    await writeFile(
      join(dataDir, 'asi-sense', 'settings.json'),
      JSON.stringify({ version: 1, paused: false, sendTitles: false }),
    );

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    await root.plugin(SessionStore);
    await root.plugin(SkillRegistry);
    root.tools.setExecutor(new NativeToolExecutor(root));

    // 创建一个包含 14 轮历史对话的现有普通会话，记录其最后事件 seq 作为旧版已整合水位线
    const histSession = root.sessions.create(SessionId('sess-macpro-hist'), {
      meta: { cwd: wsProject, isSeeded: false },
    });
    for (let t = 1; t <= 14; t += 1) {
      appendTurn(histSession, t, `历史第 ${t} 轮提问`, `历史第 ${t} 轮回答`);
    }
    const maxHistoricalSeq = Math.max(...histSession.ownEvents().map((e) => Number(e.seq)));

    await mkdir(join(dataDir, 'asi-sleep', 'vault'), { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 76; i += 1) {
      lines.push(
        JSON.stringify({
          id: `mem_mac_${i}`,
          kind: i <= 20 ? 'preference' : i <= 40 ? 'decision' : i <= 60 ? 'pitfall' : 'episode',
          title: `MacPro 历史记忆条目 ${i}`,
          content: `用于验证单插件升级后零丢失保留的历史记忆正文 #${i}。`,
          tags: ['macpro', 'migrated'],
          pinned: i <= 5,
          confidence: 0.95,
          sourceSessionIds: ['sess-macpro-hist'],
          evidenceCount: 2,
          recallCount: 1,
          createdAt: Date.now() - 86_400_000,
          updatedAt: Date.now() - 3_600_000,
          fsrs: {
            stability: 20,
            difficulty: 3.2,
            elapsedDays: 1,
            scheduledDays: 20,
            learningSteps: 0,
            reps: 2,
            lapses: 0,
            state: 2,
            due: Date.now() + 19 * 86_400_000,
            lastReview: Date.now() - 3_600_000,
          },
        }),
      );
    }
    await writeFile(join(dataDir, 'asi-sleep', 'vault', 'memories.jsonl'), `${lines.join('\n')}\n`);
    await writeFile(
      join(dataDir, 'asi-sleep', 'state.json'),
      JSON.stringify({
        autoSleepPaused: false,
        lastSleepAt: Date.now() - 1_800_000,
        firstUnconsolidatedTurnAt: null,
        lastOrdinaryActivityAt: Date.now() - 60_000,
        autoRunTimestamps: [],
        consolidatedTurnKeys: [],
        consolidatedSessionWatermarks: {
          [String(histSession.id)]: maxHistoricalSeq,
        },
      }),
    );

    // 预置旧版 ../asi-growth 中 1 个已批准全局技能
    const migratedSkillName = 'migrated-biome-guard';
    const migratedMd = renderSkillMarkdown({
      name: migratedSkillName,
      description: 'Run biome check before committing workspace changes.',
      license: 'MIT',
      body: '# Biome Guard\n\n1. Run `pnpm lint`.',
    });
    const skillDir = join(dataDir, 'asi-growth', 'skills', 'active', migratedSkillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), migratedMd);
    await writeFile(
      join(dataDir, 'asi-growth', 'catalog.json'),
      JSON.stringify({
        version: 1,
        drafts: [],
        archived: [],
        skills: [
          {
            name: migratedSkillName,
            version: 1,
            status: 'active',
            scope: 'global',
            description: 'Run biome check before committing workspace changes.',
            markdown: migratedMd,
            topicKey: 'biome-guard',
            evidenceIds: ['mem_mac_1'],
            approvedAt: Date.now() - 86_400_000,
            updatedAt: Date.now() - 86_400_000,
            invocationCount: 3,
            lastInvokedAt: Date.now() - 3_600_000,
            evaluatedTurns: 3,
            completedTurns: 3,
            exportedWorkspaces: [],
          },
        ],
      }),
    );

    const agentsList: Agent[] = [];
    const userAgent = {
      id: histSession.id,
      status: 'idle' as const,
      session: histSession,
    } as unknown as Agent & { ctx: Context };
    userAgent.ctx = createScope(root, userAgent).ctx;
    agentsList.push(userAgent);

    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
      withoutInitiator: <T>(fn: () => T) => fn(),
    });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [],
      create: async () => ({}),
      list: () => [{ id: 'ws-1', path: wsProject, sessionIds: [histSession.id] }],
    });
    root.provide('profileContext', {
      name: 'desktop',
      dir: rootDir,
      patchPath: '',
      installAnchor: '',
      cwd: wsProject,
      home: rootDir,
      startedBundles: ['asi'],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('sessionController', {
      create: async () => ({ sessionId: SessionId('asi-maint-unused') }),
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async () => ({ error: new Error('none') }),
    });

    const unifiedStorageRoot = join(dataDir, 'asi');
    const asiFork = await root.plugin(AsiPlugin, {
      storageRoot: unifiedStorageRoot,
      helperPath: join(rootDir, 'nonexistent-helper'),
      intervalMs: 15_000,
    });

    try {
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'startup' });

      // A. 验证 76 条记忆 + settings(sendTitles=false) + 已启用技能全部自动无损生效
      expect(root.asiSense.getSettings().sendTitles).toBe(false);
      expect(root.asiSleep.listMemories({ limit: 100 })).toHaveLength(76);
      expect((await root.skills.list({ cwd: wsProject })).map((s) => s.name)).toContain(migratedSkillName);

      // B. 验证历史 14 轮对话因水位线完整迁移而保持 unconsolidatedTurns = 0，新增第 15 轮才计为 1！
      const sleepDriveInitial = root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation');
      expect(sleepDriveInitial?.evidence.unconsolidatedTurns).toBe(0);

      appendTurn(histSession, 15, '升级到单插件后的新对话轮次', '已确认生效');
      root.asiDrives.notifySourceChanged('asi-sleep');
      await root.asiSense.refresh?.();
      await new Promise((r) => setTimeout(r, 30));
      expect(
        root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-sleep:consolidation')?.evidence.unconsolidatedTurns,
      ).toBe(1);

      // C. 验证普通对话可见全部 7 个只读工具且零动态提示词注入、零沙盒写工具暴露
      const prompt = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      expect(prompt.sections.map((s) => s.name)).not.toContain('asi');

      const toolNames = root.tools.definitions(userAgent).map((d) => d.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'env_state',
          'env_detail',
          'needs_status',
          'memory_recall',
          'memory_profile',
          'care_status',
          'growth_status',
        ]),
      );
      expect(toolNames).not.toContain('needs_clean_cache');
      expect(toolNames).not.toContain('sleep_consolidate');
      expect(toolNames).not.toContain('growth_synthesize');

      // D. 验证统一 AsiRemote 流 (frames) 同时返回 needs / sleep / growth 三域实时快照且支持跨层交互
      const abort = new AbortController();
      const iter = root.asi.frames(abort.signal)[Symbol.asyncIterator]();
      const firstFrame = await iter.next();
      expect(firstFrame.value?.needs.sendTitles).toBe(false);
      expect(firstFrame.value?.sleep.totalMemories).toBe(76);
      expect(firstFrame.value?.growth.activeCount).toBe(1);

      const createdDraft = await root.asi.createManualDraft({
        name: 'unified-panel-check',
        description: 'Verify unified sidebar panel skill approval end to end.',
        body: '# Unified Panel Skill\n\n1. Approve from spotlight or skill studio.',
      });
      expect(createdDraft.name).toBe('unified-panel-check');
      const approved = await root.asi.approveDraft(createdDraft.id);
      expect(approved.status).toBe('active');
      expect((await root.skills.list({ cwd: wsProject })).map((s) => s.name)).toContain('unified-panel-check');

      abort.abort();
    } finally {
      asiFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});
