import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type Agent, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type MessageId as LlmMessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService, { type ToolExecution } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as AsiPlugin from '../../src/host/dsh/index.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

function extractTextFromMessage(msg: UserMessage): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

describe('前额叶直觉与前瞻记忆（src/intuition）全链路 Cordis / DSH 集成验证', () => {
  it('严格保持零动态系统提示词（100% 保护前缀 Prompt Cache），支持 pre-step 同轮尾部闪回、空闲 next-step 合并/撤回入队、重复报错疤痕学习与读写闭环工具', {
    timeout: 60_000,
  }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'asi-intuition-cordis-'));
    tempDirs.push(rootDir);
    const wsProject = join(rootDir, 'work', 'asi-app');
    await mkdir(wsProject, { recursive: true });

    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolsService);
    await root.plugin(SessionStore);
    await root.plugin(SkillRegistry);
    root.tools.setExecutor(new NativeToolExecutor(root));

    const userSession = root.sessions.create(SessionId('sess-user-main'), {
      meta: { cwd: wsProject, isSeeded: false },
    });
    const subSession = root.sessions.create(SessionId('sess-sub-worker'), {
      meta: { cwd: wsProject, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    });

    const nextTurnQueue: UserMessage[] = [];
    const injectedNextStep: UserMessage[] = [];
    const subAgentQueue: UserMessage[] = [];

    const userAgent = {
      id: userSession.id,
      status: 'idle' as const,
      session: userSession,
      inbox: {
        get nextTurn() {
          return nextTurnQueue;
        },
        get nextStep() {
          return injectedNextStep;
        },
        replace(msgId: LlmMessageId, newMsg: UserMessage) {
          const stepIdx = injectedNextStep.findIndex((m) => m.id === msgId);
          if (stepIdx >= 0) {
            injectedNextStep[stepIdx] = newMsg;
            return true;
          }
          const turnIdx = nextTurnQueue.findIndex((m) => m.id === msgId);
          if (turnIdx >= 0) {
            nextTurnQueue[turnIdx] = newMsg;
            return true;
          }
          return false;
        },
        remove(msgId: LlmMessageId) {
          const stepIdx = injectedNextStep.findIndex((m) => m.id === msgId);
          if (stepIdx >= 0) {
            injectedNextStep.splice(stepIdx, 1);
            return true;
          }
          const turnIdx = nextTurnQueue.findIndex((m) => m.id === msgId);
          if (turnIdx >= 0) {
            nextTurnQueue.splice(turnIdx, 1);
            return true;
          }
          return false;
        },
        append(target: string, msg: UserMessage) {
          if (target === 'next-turn') nextTurnQueue.push(msg);
          else injectedNextStep.push(msg);
        },
      },
      send(msg: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean) {
        expect(wakeup).toBe(false);
        if (target === 'next-turn') nextTurnQueue.push(msg);
        else injectedNextStep.push(msg);
      },
      inject(msg: UserMessage) {
        injectedNextStep.push(msg);
      },
    } as unknown as Agent & { ctx: Context };
    userAgent.ctx = createScope(root, userAgent).ctx;

    const subAgent = {
      id: subSession.id,
      status: 'idle' as const,
      session: subSession,
      send(msg: UserMessage) {
        subAgentQueue.push(msg);
      },
    } as unknown as Agent & { ctx: Context };
    subAgent.ctx = createScope(root, subAgent).ctx;

    const maintSession = root.sessions.create(SessionId('asi-maint-int-1'), {
      meta: { cwd: join(rootDir, 'data', 'asi', 'needs', 'sandbox'), isSeeded: false },
    });
    const maintAgent = {
      id: maintSession.id,
      status: 'idle' as const,
      session: maintSession,
    } as unknown as Agent & { ctx: Context };
    maintAgent.ctx = createScope(root, maintAgent).ctx;

    const archivedSession = root.sessions.create(SessionId('sess-archived-user'), {
      meta: { cwd: wsProject, isSeeded: false },
    });
    const archivedAgent = {
      id: archivedSession.id,
      status: 'idle' as const,
      session: archivedSession,
    } as unknown as Agent & { ctx: Context };
    archivedAgent.ctx = createScope(root, archivedAgent).ctx;

    const agentsList: Agent[] = [userAgent, subAgent, maintAgent, archivedAgent];
    let jobSubscriber:
      | ((ev: { type: string; job: { id: string; owner?: string; label: string; status: string } }) => void)
      | undefined;

    root.provide('agents', {
      list: () => agentsList,
      get: (id: string) => agentsList.find((a) => a.id === id),
      withoutInitiator: <T>(fn: () => T) => fn(),
    });
    root.provide('jobs', {
      list: () => [],
      kill: () => 'already-finished',
      events: {
        subscribe: (_opts: unknown, cb: typeof jobSubscriber) => {
          jobSubscriber = cb;
          return () => {
            jobSubscriber = undefined;
          };
        },
      },
    });
    root.provide('llm', { listConfigurableProviders: () => [], resolveModelInfo: async () => undefined });
    root.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
    root.provide('tokenMeter', { contextPressure: () => ({}) });
    root.provide('workspaceRegistry', {
      archivedSessionIds: [archivedSession.id],
      create: async () => ({}),
      list: () => [{ id: 'ws-1', path: wsProject, sessionIds: [userSession.id] }],
    });
    root.provide('profileContext', {
      name: 'cli',
      dir: rootDir,
      patchPath: '',
      installAnchor: '',
      cwd: wsProject,
      home: rootDir,
      startedBundles: ['asi'],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });

    const asiFork = await root.plugin(AsiPlugin, {
      storageRoot: join(rootDir, 'data', 'asi'),
      helperPath: join(rootDir, 'nonexistent-helper'),
      intervalMs: 60_000,
      ignorePaths: [wsProject],
    });

    try {
      await asiFork.await();

      // 1. 预置一条高优踩坑记忆到 L2 记忆库
      await root.asi.createMemory({
        kind: 'pitfall',
        title: '客户端打包禁用动态 sourceMappingURL 残留',
        content: '发布包审计会严格拒绝包含 sourceMappingURL 的产物，构建脚本须关闭 sourcemap。',
        tags: ['sourcemap', 'esbuild', 'release'],
        pinned: true,
      });

      // 2. 通过模型工具 prospective_remember 登记情境型与后台任务完成型前瞻意图（且验证凭据打码）
      const rememberDef = root.tools.executable('prospective_remember', userAgent);
      expect(rememberDef).toBeDefined();

      const createdCtxRes = (await rememberDef?.execute(
        {
          title: '发版前跑完整包白名单校验',
          instruction: '在 asi-app 涉及 esbuild 发版时，先核对白名单且勿泄露 sk-live9876543210abcdef',
          triggerKind: 'context',
          workspaceMatch: 'asi-app',
          keywordMatch: 'esbuild, 发版',
          priority: 'high',
        },
        {
          callId: 'call-rem-1' as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never,
      )) as { status: string; intention: { id: string; instruction: string } };
      expect(createdCtxRes.status).toBe('created');
      expect(createdCtxRes.intention.instruction).not.toContain('sk-live9876543210abcdef');

      // 3. 验证 agent/pre-step (step === 1) 同轮尾部追加直觉闪回 + 情境前瞻，且系统提示词 100% 零污染
      const userMsg = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '现在准备调整 esbuild sourcemap 配置并执行发版' }],
      });
      const stepDecision = await root.waterfall(
        'agent/pre-step',
        {
          agent: userAgent,
          messages: [userMsg],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
          modelSelection: { provider: 'mock', model: 'mock-1' },
        },
        async () => ({ kind: 'enter' as const, messages: [userMsg] }),
      );

      expect(stepDecision.kind).toBe('enter');
      if (stepDecision.kind === 'enter') {
        expect(stepDecision.messages).toHaveLength(2);
        expect(stepDecision.messages[0]).toBe(userMsg);
        const secondMsg = stepDecision.messages[1];
        if (!secondMsg) throw new Error('expected appended intuition message');
        const tailText = extractTextFromMessage(secondMsg);
        expect(tailText).toContain('<asi-intuition mode="combined"');
        expect(tailText).toContain('发版前跑完整包白名单校验');
        expect(tailText).toContain('客户端打包禁用动态 sourceMappingURL 残留');
      }

      // 同一会话冷却期内再次发送相同话题，不重复刷屏轰炸躯体标记闪回
      const stepDecisionRepeat = await root.waterfall(
        'agent/pre-step',
        {
          agent: userAgent,
          messages: [userMsg],
          turn: 2,
          step: 1,
          signal: new AbortController().signal,
          modelSelection: { provider: 'mock', model: 'mock-1' },
        },
        async () => ({ kind: 'enter' as const, messages: [userMsg] }),
      );
      if (stepDecisionRepeat.kind === 'enter') {
        expect(stepDecisionRepeat.messages).toHaveLength(1);
      }

      const assembledPrompt = await root.systemPrompt.assemble({ agent: userAgent, scope: userAgent });
      expect(assembledPrompt.sections.some((s) => s.name.includes('intuition'))).toBe(false);

      // 4. 验证空闲期间两条异步前瞻触发时在 next-turn 队列原位合并（replace coalescing）且绝不唤醒会话或污染 subagent
      await rememberDef?.execute(
        {
          title: '长构建任务结束后检查产物大小',
          instruction: '构建作业完成后核查 dist 体积',
          triggerKind: 'event',
          eventKind: 'job_finished',
          targetPattern: 'pack:dist',
        },
        {
          callId: 'call-rem-2' as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never,
      );
      await rememberDef?.execute(
        {
          title: '新会话启动对齐分支状态',
          instruction: '开启会话后先核对当前工作树干净度',
          triggerKind: 'event',
          eventKind: 'next_session',
        },
        {
          callId: 'call-rem-3' as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never,
      );

      jobSubscriber?.({
        type: 'settled',
        job: { id: 'job-1', owner: String(userAgent.id), label: 'pnpm run pack:dist', status: 'completed' },
      });
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'resume' });
      emitAgentEvent(root, subAgent, 'agent/created', { source: 'startup' });

      expect(subAgentQueue).toHaveLength(0);
      expect(nextTurnQueue).toHaveLength(0);
      expect(injectedNextStep).toHaveLength(1);
      const firstQueued = injectedNextStep[0];
      if (!firstQueued) throw new Error('expected parked next-step message');
      const coalescedText = extractTextFromMessage(firstQueued);
      expect(coalescedText).toContain('长构建任务结束后检查产物大小');
      expect(coalescedText).toContain('新会话启动对齐分支状态');

      // 验证取消/完成已驻留事件提醒时通过 inbox.remove 干净撤回 next-step 驻留消息（零残留）
      expect(root.asiIntuition.snapshot().surfacedCount).toBeGreaterThanOrEqual(3);
      const resolveForRetract = root.tools.executable('prospective_resolve', userAgent);
      for (const surfacedItem of root.asiIntuition.listIntentions({ statuses: ['surfaced'] })) {
        if (surfacedItem.id === createdCtxRes.intention.id) continue;
        await resolveForRetract?.execute({ id: surfacedItem.id, action: 'cancel' }, {
          callId: `call-retract-${surfacedItem.id}` as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never);
      }
      expect(injectedNextStep).toHaveLength(0);

      // 再次驻留一条提醒后开启暂停 -> 立即通过 inbox.remove 撤回驻留消息，且暂停态工具失败不落疤痕
      await rememberDef?.execute(
        {
          title: '暂停撤回验证提醒',
          instruction: '验证暂停时自动撤回 next-step 驻留消息',
          triggerKind: 'event',
          eventKind: 'next_session',
        },
        {
          callId: 'call-rem-pause' as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never,
      );
      emitAgentEvent(root, userAgent, 'agent/created', { source: 'resume' });
      expect(injectedNextStep).toHaveLength(1);

      await root.asi.setAutoIntuitionPaused(true);
      expect(injectedNextStep).toHaveLength(0);

      const pausedScarExec: ToolExecution = {
        callId: 'tc-paused-scar' as never,
        rootCallId: 'tc-paused-scar' as never,
        token: Symbol() as never,
        name: 'bash',
        arguments: { command: 'pnpm --filter paused-pkg run test' },
        agent: userAgent,
        signal: new AbortController().signal,
      };
      root.emit('tools/result', pausedScarExec, {
        content: [{ type: 'text', text: 'err1' }],
        isError: true,
        value: { kind: 'foreground', exitCode: 1 },
      } as never);
      root.emit('tools/result', pausedScarExec, {
        content: [{ type: 'text', text: 'err2' }],
        isError: true,
        value: { kind: 'foreground', exitCode: 1 },
      } as never);
      await root.asi.setAutoIntuitionPaused(false);
      await root.waterfall('tools/pre-execute', pausedScarExec, async () => ({ kind: 'allow' as const }));
      expect(injectedNextStep).toHaveLength(0);

      // 5. 验证工具连续失败 2 次形成短期报错疤痕（SomaticScar），并在下次工具 pre-execute 时自动 inject 预警
      const fakeExec: ToolExecution = {
        callId: 'tc-scar' as never,
        rootCallId: 'tc-scar' as never,
        token: Symbol() as never,
        name: 'bash',
        arguments: { command: 'pnpm --filter broken-pkg run build' },
        agent: userAgent,
        signal: new AbortController().signal,
      };
      root.emit('tools/result', fakeExec, {
        content: [{ type: 'text', text: 'failed' }],
        isError: false,
        value: { kind: 'foreground', exitCode: 2 },
      } as never);
      root.emit('tools/result', fakeExec, {
        content: [{ type: 'text', text: 'failed again' }],
        isError: false,
        value: { kind: 'foreground', exitCode: 2 },
      } as never);

      expect(root.asiIntuition.snapshot().surfacedCount).toBeGreaterThanOrEqual(1);
      await root.waterfall('tools/pre-execute', fakeExec, async () => ({ kind: 'allow' as const }));
      expect(injectedNextStep.length).toBeGreaterThanOrEqual(1);
      const stepWarnMsg = injectedNextStep.at(-1);
      if (!stepWarnMsg) throw new Error('expected injected step warning');
      expect(extractTextFromMessage(stepWarnMsg)).toContain('本轮重复报错疤痕');

      // 并发竞态回归验证：当同轮中途 injectNextStep (asi-intuition-step:*) 与异步驻留前瞻 (asi-intuition-ns:*) 并存时，
      // 消费掉中途 step 警告绝不能误删驻留前瞻的 MessageId，随后 cancel 仍能通过 inbox.remove 精准撤回驻留消息！
      const raceRem = (await rememberDef?.execute(
        {
          title: '并发队列隔离验证提醒',
          instruction: '验证中途 step 消息消费不会令驻留 next-step 失联',
          triggerKind: 'event',
          eventKind: 'job_finished',
          targetPattern: 'race-build',
        },
        {
          callId: 'call-rem-race' as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never,
      )) as { intention: { id: string } };
      jobSubscriber?.({
        type: 'settled',
        job: { id: 'job-race', owner: String(userAgent.id), label: 'pnpm run race-build', status: 'completed' },
      });
      expect(injectedNextStep).toHaveLength(2);
      // 模拟 DSH 引擎消费掉第一条中途疤痕消息 (stepWarnMsg)
      injectedNextStep.shift();
      emitAgentEvent(root, userAgent, 'agent/inbox/claimed', { message: stepWarnMsg, turn: 3 });
      expect(injectedNextStep).toHaveLength(1);
      // 取消并发驻留的前瞻提醒 -> 仍必须精确调用 inbox.remove 将其从队列撤回！
      await resolveForRetract?.execute({ id: raceRem.intention.id, action: 'cancel' }, {
        callId: 'call-cancel-race' as never,
        agent: userAgent,
        signal: new AbortController().signal,
      } as never);
      expect(injectedNextStep).toHaveLength(0);

      // 子代理、内部自维护会话与已归档会话调用全部 3 个 intuition 工具均被严格拦截
      const statusToolGuard = root.tools.executable('intuition_status', userAgent);
      for (const nonOrdinary of [subAgent, maintAgent, archivedAgent]) {
        for (const [toolExec, sampleArgs] of [
          [statusToolGuard, {}],
          [rememberDef, { title: 'x', instruction: 'y', triggerKind: 'event', eventKind: 'next_session' }],
          [resolveForRetract, { id: 'int_none', action: 'cancel' }],
        ] as const) {
          await expect(
            toolExec?.execute(
              sampleArgs as never,
              {
                callId: 'call-guard' as never,
                agent: nonOrdinary,
                signal: new AbortController().signal,
              } as never,
            ),
          ).rejects.toThrow(/restricted to ordinary user sessions/);
        }
      }

      // 6. 调用 prospective_resolve 完成前瞻提醒并通过 intuition_status 自检核验
      const resolveDef = root.tools.executable('prospective_resolve', userAgent);
      const resolvedRes = (await resolveDef?.execute(
        {
          id: createdCtxRes.intention.id,
          action: 'fulfill',
          note: '已完成发版前白名单核对',
        },
        {
          callId: 'call-res-1' as never,
          agent: userAgent,
          signal: new AbortController().signal,
        } as never,
      )) as { status: string };
      expect(resolvedRes.status).toBe('fulfilled');

      const statusDef = root.tools.executable('intuition_status', userAgent);
      const statusRes = (await statusDef?.execute({ contextQuery: 'esbuild sourcemap', includeCompleted: true }, {
        callId: 'call-stat-1' as never,
        agent: userAgent,
        signal: new AbortController().signal,
      } as never)) as { fulfilledCount: number; flashbacks: { sourceId: string }[] };
      expect(statusRes.fulfilledCount).toBe(1);
      expect(statusRes.flashbacks.length).toBeGreaterThanOrEqual(1);

      // 7. 验证 AsiRemote RPC 全套直觉动作、eco 节能模式压制与暂停保护
      const rpcCreated = await root.asi.createProspectiveIntention({
        title: 'RPC 创建定时提醒',
        instruction: '30 分钟后复核日志',
        triggerKind: 'time',
        delayMinutes: 30,
      });
      expect(rpcCreated.status).toBe('pending');

      const rpcSnoozed = await root.asi.resolveProspectiveIntention({
        id: rpcCreated.id,
        action: 'snooze',
        snoozeMinutes: 15,
      });
      expect(rpcSnoozed.status).toBe('snoozed');

      const rpcHits = await root.asi.scanIntuitionFlashbacks('esbuild sourcemap');
      expect(rpcHits.length).toBeGreaterThanOrEqual(1);
      await root.asi.recordFlashbackFeedback('mem_nonexistent', 'helpful');
      await root.asi.deleteProspectiveIntention(rpcCreated.id);

      await root.asiSense.setPowerMode('eco', '电量紧张测试');
      expect(root.asiIntuition.snapshot().suppressed).toBe(true);
      expect(
        root.asiDrives.snapshot().drives.find((d) => d.key === 'asi-intuition:prospective_sentinel')?.suppressed,
      ).toBe(true);

      await root.asiSense.setPowerMode('normal');
      expect(root.asiIntuition.snapshot().suppressed).toBe(false);

      await root.asi.setAutoIntuitionPaused(true);
      expect(root.asiIntuition.snapshot().autoIntuitionPaused).toBe(true);
      expect(root.asiIntuition.snapshot().suppressed).toBe(true);
    } finally {
      asiFork.dispose();
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});
