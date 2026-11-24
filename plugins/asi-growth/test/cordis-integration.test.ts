import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import {
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  LlmRuntime,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import * as AsiCarePlugin from 'asi-care';
import * as AsiNeedsPlugin from 'asi-needs';
import * as AsiSensePlugin from 'asi-sense';
import * as AsiSleepPlugin from 'asi-sleep';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as AsiGrowthPlugin from '../src/host/dsh/index.js';

const execFile = promisify(execFileCb);
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

describe('五插件全栈 Cordis 联合集成（asi-sense + asi-needs + asi-sleep + asi-care + asi-growth + dsh-skill）', () => {
  it('逆序同载 5 插件：ctx.asiSleep -> L4 高证据联动、L3 自维护禁止抢跑 L2/L4、人工批准热挂载 ctx.skills（含 global/workspace 隔离）、回合完成率追踪、零提示词污染与三面板 CSS 100% 零冲突', {
    timeout: 40_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-5plugin-cordis-'));
    tempDirs.push(dir);

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Bot',
      GIT_AUTHOR_EMAIL: 'bot@test.local',
      GIT_COMMITTER_NAME: 'Test Bot',
      GIT_COMMITTER_EMAIL: 'bot@test.local',
    };
    const wsAlpha = join(dir, 'work', 'repo-alpha');
    const wsBeta = join(dir, 'work', 'repo-beta');
    await mkdir(wsAlpha, { recursive: true });
    await mkdir(wsBeta, { recursive: true });
    await execFile('git', ['init', '-b', 'main'], { cwd: wsAlpha, env: gitEnv });
    await writeFile(join(wsAlpha, 'index.ts'), 'export const alpha = 1;\n');
    await execFile('git', ['add', '.'], { cwd: wsAlpha, env: gitEnv });
    await execFile('git', ['commit', '-m', 'init'], { cwd: wsAlpha, env: gitEnv });

    const alphaGitDir = (
      await execFile('git', ['rev-parse', '--absolute-git-dir'], { cwd: wsAlpha, env: gitEnv })
    ).stdout.trim();
    const deadLock = join(alphaGitDir, 'index.lock');
    await writeFile(deadLock, '');
    const fourHoursAgoSec = (Date.now() - 4 * 3_600_000) / 1000;
    const setTreeMtimeSec = async (target: string): Promise<void> => {
      const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = join(target, entry.name);
        if (entry.isDirectory()) await setTreeMtimeSec(full);
        else await utimes(full, fourHoursAgoSec, fourHoursAgoSec);
      }
      await utimes(target, fourHoursAgoSec, fourHoursAgoSec);
    };
    await setTreeMtimeSec(wsAlpha);
    await setTreeMtimeSec(alphaGitDir);

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    await root.plugin(SessionStore);
    await root.plugin(SkillRegistry);
    root.tools.setExecutor(new NativeToolExecutor(root));

    root.tools.register(
      defineTool({
        name: 'shell',
        description: 'external shell',
        parameters: {},
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const agentsList: Agent[] = [];
    const workspaces: Array<{ id: string; path: string; title?: string; sessionIds: SessionId[] }> = [
      { id: 'ws-alpha', path: wsAlpha, title: 'Alpha Repo', sessionIds: [] },
      { id: 'ws-beta', path: wsBeta, title: 'Beta Repo', sessionIds: [] },
    ];

    let autoTurnRan = false;
    let growthGuardDeniedInAutoTurn = false;
    let growthExecDeniedInAutoTurn = false;

    const userSession = root.sessions.create(SessionId('user-5p-chat'), {
      meta: {
        cwd: wsBeta,
        isSeeded: false,
      },
    });
    const subagentSession = root.sessions.create(SessionId('subagent-5p-1'), {
      meta: {
        cwd: wsBeta,
        origin: 'subagent',
        delegationDepth: 1,
        isSeeded: false,
      },
    });

    const userAgent = {
      id: userSession.id,
      status: 'idle' as const,
      session: userSession,
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
      create: async (path: string, title?: string) => {
        const ws = { id: `ws-${workspaces.length + 1}`, path, title, sessionIds: [] as SessionId[] };
        workspaces.push(ws);
        return ws;
      },
      list: () => workspaces,
    });
    root.provide('profileContext', {
      name: 'profile-5p',
      dir,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: dir,
      startedBundles: ['asi-growth', 'asi-care', 'asi-sleep', 'asi-needs', 'asi-sense'],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('sessionController', {
      create: async (req: { workspaceId?: string; cwd?: string }) => {
        const mintedId = SessionId('session-maint-5p');
        const ws = workspaces.find((w) => w.id === req.workspaceId);
        const maintSession = root.sessions.create(mintedId, {
          meta: {
            cwd: ws?.path ?? req.cwd ?? join(dir, 'needs', 'sandbox'),
            isSeeded: false,
          },
        });
        ws?.sessionIds.push(mintedId);

        let turnPromise: Promise<void> = Promise.resolve();
        const maintAgent = {
          id: mintedId,
          status: 'idle' as const,
          session: maintSession,
          send: () => {},
          cancel: () => {},
          whenIdle: () => turnPromise,
          followup: () => {
            turnPromise = (async () => {
              const guardCheck = root.tools.checkGuards({ name: 'growth_synthesize', agent: maintAgent } as never);
              growthGuardDeniedInAutoTurn = Boolean(
                guardCheck?.reason?.includes('autoMaintain=false') ||
                  guardCheck?.reason?.includes('forbids non-whitelisted tools'),
              );

              const synthExec = root.tools.executable('growth_synthesize', maintAgent);
              if (!synthExec) {
                growthExecDeniedInAutoTurn = true;
              } else {
                try {
                  await synthExec.execute({ force: true }, {
                    agent: maintAgent,
                    signal: new AbortController().signal,
                    callId: 'auto-growth-1' as never,
                  } as never);
                } catch (err) {
                  growthExecDeniedInAutoTurn = String(err).includes('autoMaintain=false');
                }
              }

              const cleanLocksExec = root.tools.executable('care_clean_git_locks', maintAgent);
              await cleanLocksExec?.execute({}, {
                agent: maintAgent,
                signal: new AbortController().signal,
                callId: 'auto-care-5p' as never,
              } as never);
              autoTurnRan = true;
            })();
          },
        } as unknown as Agent & { ctx: Context };
        maintAgent.ctx = createScope(root, maintAgent).ctx;
        agentsList.push(maintAgent);
        emitAgentEvent(root, maintAgent, 'agent/created', { source: 'startup' });
        return { sessionId: mintedId };
      },
      rename: async () => ({ title: 'ASI 自维护', seq: 1 }),
      resolveAgent: async (sid: string) => {
        const found = agentsList.find((a) => a.id === sid);
        return found ? { agent: found } : { error: new Error('not found') };
      },
    });

    // 按完整逆序挂载 5 个插件（asi-growth -> asi-care -> asi-sleep -> asi-needs -> asi-sense）
    const growthFork = await root.plugin(AsiGrowthPlugin, { storageRoot: join(dir, 'growth') });
    const careFork = await root.plugin(AsiCarePlugin, { storageRoot: join(dir, 'care') });
    const sleepFork = await root.plugin(AsiSleepPlugin, { storageRoot: join(dir, 'sleep') });
    const needsFork = await root.plugin(AsiNeedsPlugin, { storageRoot: join(dir, 'needs') });
    const senseFork = await root.plugin(AsiSensePlugin, {
      storageRoot: join(dir, 'sense'),
      helperPath: join(dir, 'nonexistent-helper'),
      intervalMs: 10_000,
    });

    try {
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'startup' });

      // 1. 校验零动态系统提示词污染
      const prompt = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      expect(prompt.sections.map((s) => s.name)).not.toContain('asi-growth');
      expect(prompt.sections.map((s) => s.text).join('\n')).not.toContain('asi-growth');

      // 2. 等待 L3 自动清理死锁完成，验证自动维护回合严禁越权调用 L4 growth_synthesize
      await vi.waitFor(() => expect(autoTurnRan).toBe(true), { timeout: 15_000 });
      expect(growthGuardDeniedInAutoTurn).toBe(true);
      expect(growthExecDeniedInAutoTurn).toBe(true);
      expect(existsSync(deadLock)).toBe(false);

      // 3. 验证子代理多步排障对话被 100% 排除
      for (let i = 1; i <= 4; i += 1) {
        appendTurn(subagentSession, i, '子代理排查报错失败', '子代理修复');
      }
      expect(root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-growth:skill_synthesis')?.satisfaction).toBe(
        100,
      );

      // 4. 通过 asi-sleep 写入同主题 3 条高保留率记忆（含测试凭据 + pitfall + decision + preference），验证 ctx.asiSleep -> L4 实时联动！
      const fakeSecret = ['ghp', 'SecretForGrowthIntegration1234567890'].join('_');
      await root.asiSleep.createMemory({
        kind: 'pitfall',
        topicKey: 'cordis-lifecycle',
        title: 'Cordis 插件逆序卸载必须释放子监听器',
        content: `卸载泄漏会导致悬空引用（附测试令牌 ${fakeSecret}）。`,
        tags: ['cordis'],
        pinned: true,
      });
      await root.asiSleep.createMemory({
        kind: 'decision',
        topicKey: 'cordis-lifecycle',
        title: '统一在 ctx.effect 中清理定时器与订阅',
        content: '所有后台定时器均调用 unref 并随插件生命周期销毁。',
        tags: ['cordis'],
      });
      await root.asiSleep.createMemory({
        kind: 'preference',
        topicKey: 'cordis-lifecycle',
        title: '偏好用逆序插件加载单测验证拓扑收敛',
        content: '集成测试固定覆盖逆序挂载与逆序卸载。',
        tags: ['cordis'],
      });

      await root.asiSense.refresh?.();
      await new Promise((r) => setTimeout(r, 30));

      const l4Drive = root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-growth:skill_synthesis');
      expect(l4Drive?.tier).toBe(4);
      expect(l4Drive?.satisfaction).toBeLessThan(60);
      expect(l4Drive?.zone).toBe('uncomfortable');

      // 5. 手动立即提炼草案 -> 批准前 ctx.skills 为空 -> 批准后立即热挂载至 ctx.skills 且支持 global/workspace 隔离！
      const synRec = await root.asiGrowth.synthesizeNow();
      expect(synRec.draftsCreated).toBe(1);
      expect(await root.skills.list({ cwd: wsAlpha })).toHaveLength(0);

      const statusTool = root.tools.executable('growth_status', userAgent);
      expect(statusTool).toBeDefined();
      const statusBeforeApprove = (await statusTool?.execute({ status: 'draft' }, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'gs-1' as never,
      } as never)) as { drafts: Array<{ id: string; name: string }> };
      expect(statusBeforeApprove.drafts).toHaveLength(1);
      expect(JSON.stringify(statusBeforeApprove)).not.toContain(fakeSecret);

      const firstDraft = statusBeforeApprove.drafts[0];
      expect(firstDraft).toBeDefined();
      const draftId = firstDraft?.id ?? '';
      const approved = await root.asiGrowth.approveDraft(draftId);
      expect(approved.status).toBe('active');

      // 全局作用域下 wsAlpha 与 wsBeta 均可见，但 ASI 内部目录与子代理/内部会话严格不可见！
      const alphaCatalogGlobal = await root.skills.list({ cwd: wsAlpha });
      expect(alphaCatalogGlobal.map((s) => s.name)).toContain(approved.name);
      expect(await root.skills.list({ cwd: join(dir, 'needs', 'sandbox') })).toEqual([]);
      expect(await root.skills.list({ cwd: join(dir, 'sleep') })).toEqual([]);
      const subagentScope = { id: subagentSession.id, session: subagentSession } as never;
      expect(await root.skills.list({ cwd: wsBeta, scope: subagentScope })).toEqual([]);
      const loadedDef = await root.skills.get(approved.name, { cwd: wsAlpha });
      expect(loadedDef?.provider).toBe('asi-growth');
      expect(loadedDef?.content).toContain('Cordis');
      expect(loadedDef?.content).not.toContain(fakeSecret);

      // 子代理与 asi-* 内部会话调用 growth_status 也被严格拒绝
      await expect(
        statusTool?.execute({}, {
          agent: { id: subagentSession.id, session: subagentSession } as never,
          signal: new AbortController().signal,
          callId: 'gs-sub-deny' as never,
        } as never),
      ).rejects.toThrow(/ordinary user sessions/);

      // 切换为 wsAlpha 工作区专属作用域 -> wsAlpha 可见，wsBeta 与无 cwd 立即不可见（热重载生效）！
      await root.asiGrowth.setSkillScope(approved.name, { scope: 'workspace', workspacePath: wsAlpha });
      expect((await root.skills.list({ cwd: wsAlpha })).map((s) => s.name)).toContain(approved.name);
      expect((await root.skills.list({ cwd: wsBeta })).map((s) => s.name)).not.toContain(approved.name);
      expect((await root.skills.list({})).map((s) => s.name)).not.toContain(approved.name);
      expect(await root.skills.get(approved.name, { cwd: wsBeta })).toBeUndefined();

      // 6. 模拟真实会话在 turn/start 之前先投递 user/message (skill-invocation) 并正常完成回合 -> turnCompletionRate 仍精确记录为 1 (100%)
      userSession.append(
        'user/message',
        createUserMessage({
          source: { kind: 'skill-invocation', name: approved.name, form: 'instructions' },
          content: [{ type: 'text', text: '<skill_content>...</skill_content>' }],
        }),
        { surfaceOp: 'append' },
      );
      userSession.append('turn/start', { turn: 50 });
      userSession.append('turn/end', { turn: 50, reason: { kind: 'completed' } });

      const statusAfterTurn = (await statusTool?.execute({ status: 'active' }, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'gs-2' as never,
      } as never)) as { skills: Array<{ name: string; turnCompletionRate: number | null }> };
      expect(statusAfterTurn.skills.find((s) => s.name === approved.name)?.turnCompletionRate).toBe(1);

      // 7. AsiGrowthRemote 非 owner 身份拦截与错误消息脱敏防护
      const nonOwnerSelf = {
        ctx: { invocation: { peer: { principal: { kind: 'guest', id: 'peer-1' } } } },
        checkUser: AsiGrowthPlugin.AsiGrowthRemote.prototype['checkUser' as keyof AsiGrowthPlugin.AsiGrowthRemote],
      };
      await expect(
        AsiGrowthPlugin.AsiGrowthRemote.prototype.approveDraft.call(nonOwnerSelf as never, 'x'),
      ).rejects.toThrow(/User access required/);

      const badTok = ['ghp', 'BadArgSecretToken1234567890abcdef'].join('_');
      await expect(
        root.asiGrowth.updateSkill('nonexistent', { markdown: `---\nname: ${badTok}\n---` }),
      ).rejects.satisfy((err: Error) => !err.message.includes(badTok));

      // 8. 普通用户会话可见全部 7 个 ASI 只读工具，且绝不见任何后台沙盒写工具
      const userTools = root.tools.definitions(userAgent).map((d) => d.name);
      for (const ro of [
        'env_state',
        'env_detail',
        'needs_status',
        'memory_recall',
        'memory_profile',
        'care_status',
        'growth_status',
      ]) {
        expect(userTools).toContain(ro);
      }
      for (const hidden of ['needs_clean_cache', 'sleep_consolidate', 'care_clean_git_locks', 'growth_synthesize']) {
        expect(userTools).not.toContain(hidden);
      }
    } finally {
      growthFork.dispose();
      careFork.dispose();
      sleepFork.dispose();
      needsFork.dispose();
      senseFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
    }

    // 9. 强制校验三侧栏面板（asi-needs / asi-sleep / asi-growth）客户端 bundle 的 CSS Module 选择器两两 100% 零重叠！
    const growthPkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const needsPkgDir = resolve(growthPkgDir, '../asi-needs');
    const sleepPkgDir = resolve(growthPkgDir, '../asi-sleep');

    for (const pkg of [needsPkgDir, sleepPkgDir, growthPkgDir]) {
      if (!existsSync(join(pkg, 'lib/client.js'))) {
        const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: pkg, encoding: 'utf8' });
        expect(built.status, built.stderr || built.stdout).toBe(0);
      }
    }

    const [needsBundle, sleepBundle, growthBundle] = await Promise.all([
      readFile(join(needsPkgDir, 'lib/client.js'), 'utf8'),
      readFile(join(sleepPkgDir, 'lib/client.js'), 'utf8'),
      readFile(join(growthPkgDir, 'lib/client.js'), 'utf8'),
    ]);

    const extractCssClasses = (bundle: string): Set<string> => {
      const match = /const __asi(?:Needs|Sleep|Growth)Styles=("(?:\\.|[^"\\])*");/.exec(bundle);
      const cssText = match?.[1] ? (JSON.parse(match[1]) as string) : '';
      return new Set(
        [...cssText.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1] ?? '').filter((cls) => cls.includes('_')),
      );
    };

    const needsClasses = extractCssClasses(needsBundle);
    const sleepClasses = extractCssClasses(sleepBundle);
    const growthClasses = extractCssClasses(growthBundle);

    expect(needsClasses.size).toBeGreaterThan(10);
    expect(sleepClasses.size).toBeGreaterThan(10);
    expect(growthClasses.size).toBeGreaterThan(10);

    expect([...growthClasses].filter((c) => needsClasses.has(c))).toEqual([]);
    expect([...growthClasses].filter((c) => sleepClasses.has(c))).toEqual([]);
    expect([...sleepClasses].filter((c) => needsClasses.has(c))).toEqual([]);
  });

  it('真实挂载 LlmRuntime + sessionQuery 冷会话水合：从冷会话复现轨迹触发 L4 并通过流式 LLM 提炼 SKILL.md', {
    timeout: 25_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-growth-cold-llm-'));
    tempDirs.push(dir);
    const wsCold = join(dir, 'work', 'cold-repo');
    await mkdir(wsCold, { recursive: true });

    // 构造 2 个不驻留在 ctx.sessions 的离线持久化冷会话（相同排障主题复现 >=2 次）
    const coldS1 = Session.create(SessionId('cold-sess-1'), undefined, {
      version: 4,
      id: SessionId('cold-sess-1'),
      createdAt: Date.now() - 3_600_000,
      cwd: wsCold,
      isSeeded: false,
    });
    const coldS2 = Session.create(SessionId('cold-sess-2'), undefined, {
      version: 4,
      id: SessionId('cold-sess-2'),
      createdAt: Date.now() - 1_800_000,
      cwd: wsCold,
      isSeeded: false,
    });

    for (const [idx, cs] of [coldS1, coldS2].entries()) {
      cs.append('model/selection', { provider: 'mock-llm', model: 'synth-v1' });
      cs.append('turn/start', { turn: 1 });
      cs.append('step/start', { turn: 1, step: 1 });
      cs.append(
        'user/message',
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: `排查 SQLite BUSY_TIMEOUT 锁表失败问题 #${idx + 1}` }],
        }),
        { surfaceOp: 'append' },
      );
      cs.append('tool/call', { callId: `c-${idx}-1` as never, name: 'read_file', input: {} } as never);
      cs.append('tool/call', { callId: `c-${idx}-2` as never, name: 'edit_file', input: {} } as never);
      cs.append(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            source: { provider: 'mock-llm', model: 'synth-v1' },
            content: [{ type: 'text', text: '开启 WAL 模式与 busy_timeout=5000 后恢复正常。' }],
          }),
          stream: [],
        },
        { surfaceOp: 'append' },
      );
      cs.append('step/end', { turn: 1, step: 1 });
      cs.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    }

    let capturedPrompt = '';
    class MockSynthAdapter extends LlmAdapter {
      override providerInfo(provider: string): LlmProviderInfo {
        return { id: provider, name: 'Mock Synth' };
      }
      override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        return [{ id: 'synth-v1', name: 'Synth V1', provider }];
      }
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { id: model, name: model, provider };
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const firstBlock = options.messages[0]?.content[0];
        if (firstBlock?.type === 'text') capturedPrompt = firstBlock.text;
        const jsonPayload = JSON.stringify({
          description: 'Configure SQLite WAL mode and busy_timeout to eliminate lock contention failures.',
          whenToUse: 'Use when diagnosing SQLite SQLITE_BUSY or database lock timeouts.',
          body: '# SQLite Lock Contention Guard\n\n## Standard Procedure\n1. Enable PRAGMA journal_mode=WAL.\n2. Set PRAGMA busy_timeout=5000.',
        });
        yield { type: 'text-delta', index: 0, text: jsonPayload.slice(0, 40) };
        yield { type: 'text-delta', index: 0, text: jsonPayload.slice(40) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    await root.plugin(SessionStore);
    await root.plugin(SkillRegistry);
    await root.plugin(LlmRuntime);
    root.llm.registerAdapter(['mock-llm'], new MockSynthAdapter());
    root.tools.setExecutor(new NativeToolExecutor(root));

    root.provide('agents', { list: () => [], get: () => undefined, withoutInitiator: <T>(fn: () => T) => fn() });
    root.provide('jobs', { list: () => [], kill: () => 'already-finished', events: { subscribe: () => () => {} } });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('workspaceRegistry', { archivedSessionIds: [], create: async () => ({}), list: () => [] });
    root.provide('profileContext', {
      name: 'profile-cold',
      dir,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: dir,
      startedBundles: ['asi-sense', 'asi-needs', 'asi-growth'],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    root.provide('sessionController', {
      create: async () => ({ sessionId: SessionId('unused') }),
      rename: async () => ({ title: '', seq: 1 }),
      resolveAgent: async () => ({ error: new Error('none') }),
    });
    root.provide('sessionQuery', {
      listSessions: async () => [
        { header: coldS1.header, live: false },
        { header: coldS2.header, live: false },
      ],
      readTitle: async (id: string) => ({ title: `Cold SQLite #${id}`, seq: 1 }),
      readSession: async (id: string) => {
        const target = String(id) === 'cold-sess-1' ? coldS1 : coldS2;
        return {
          session: target.header,
          events: target.ownEvents(),
          inheritedEventCount: 0,
        };
      },
    });

    const senseFork = await root.plugin(AsiSensePlugin, {
      storageRoot: join(dir, 'sense'),
      helperPath: join(dir, 'nonexistent-helper'),
      intervalMs: 10_000,
    });
    const needsFork = await root.plugin(AsiNeedsPlugin, { storageRoot: join(dir, 'needs') });
    const growthFork = await root.plugin(AsiGrowthPlugin, { storageRoot: join(dir, 'growth') });

    try {
      await vi.waitFor(
        () => {
          const d = root.asiDrives.snapshot().drives.find((x) => x.key === 'asi-growth:skill_synthesis');
          expect(d?.satisfaction).toBeLessThan(60);
        },
        { timeout: 5_000 },
      );

      const rec = await root.asiGrowth.synthesizeNow();
      expect(rec.draftsCreated).toBe(1);
      expect(capturedPrompt).toContain('BUSY_TIMEOUT');

      const userSession = root.sessions.create(SessionId('verify-cold-user'), {
        meta: { cwd: wsCold, isSeeded: false },
      });
      const userAgent = { id: userSession.id, status: 'idle', session: userSession } as unknown as Agent;
      const statusTool = root.tools.executable('growth_status', userAgent);
      const snap = (await statusTool?.execute({ status: 'draft' }, {
        agent: userAgent,
        signal: new AbortController().signal,
        callId: 'gs-cold' as never,
      } as never)) as { drafts: Array<{ id: string; description: string; scope: string }> };

      expect(snap.drafts).toHaveLength(1);
      expect(snap.drafts[0]?.description).toContain('SQLite WAL mode');
      expect(snap.drafts[0]?.scope).toBe('workspace');
    } finally {
      growthFork.dispose();
      needsFork.dispose();
      senseFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});
