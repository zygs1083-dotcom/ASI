import type { NeedsSnapshot, SenseSnapshot } from '@asi/sense-types';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeGrowthScenario } from '../../src/growth/mock-scenarios.js';
import { createAsiFramesSource } from '../../src/host/dsh/frames.js';
import { AsiRemote } from '../../src/host/dsh/remote.js';
import { makeIntuitionScenario } from '../../src/intuition/mock-scenarios.js';
import { createFramesSource, DEFAULT_FRAME_THROTTLE_MS } from '../../src/needs/host/dsh/frames.js';
import type { NeedsRuntime } from '../../src/needs/host/runtime.js';
import { makeSleepScenario } from '../../src/sleep/mock-scenarios.js';
import { fact, makeSnapshot, T0 } from './fixtures.js';

function createStubRuntime(initialCpu = 0.1) {
  const listeners = new Set<() => void>();
  const senseSnap: SenseSnapshot = makeSnapshot({ now: T0, mono: 1_000 });
  senseSnap.state.self.body.cpu = fact({ usage: initialCpu, perCore: [initialCpu], load1: 1, load5: 1, load15: 1 });

  let snapshotCalls = 0;
  const needsSnap: NeedsSnapshot = {
    now: T0,
    paused: false,
    sendTitles: true,
    overallSatisfaction: 92,
    overallUrgency: 8,
    overallZone: 'comfortable',
    activeDrives: [],
    needs: {
      energy: {
        key: 'energy',
        label: '能量',
        satisfaction: 92,
        urgency: 8,
        zone: 'comfortable',
        driveActive: false,
        summary: '电量充足',
        evidence: {},
        updatedAt: T0,
      },
      space: {
        key: 'space',
        label: '空间',
        satisfaction: 95,
        urgency: 5,
        zone: 'comfortable',
        driveActive: false,
        summary: '空间充裕',
        evidence: {},
        updatedAt: T0,
      },
      memory: {
        key: 'memory',
        label: '内存与进程',
        satisfaction: 94,
        urgency: 6,
        zone: 'comfortable',
        driveActive: false,
        summary: '内存正常',
        evidence: {},
        updatedAt: T0,
      },
      mind: {
        key: 'mind',
        label: '心智容量',
        satisfaction: 93,
        urgency: 7,
        zone: 'comfortable',
        driveActive: false,
        summary: '容量充裕',
        evidence: {},
        updatedAt: T0,
      },
      thermals: {
        key: 'thermals',
        label: '体温负荷',
        satisfaction: 96,
        urgency: 4,
        zone: 'comfortable',
        driveActive: false,
        summary: '温度正常',
        evidence: {},
        updatedAt: T0,
      },
    },
    instinct: { powerMode: 'normal', modelConnectivity: 'online', probeCount: 1 },
    helpCards: [],
    maintenanceSession: { title: 'ASI 自维护', status: 'not-created', turnCount: 0 },
    records: [],
  };

  const offSpy = vi.fn();

  const runtime = {
    sandboxDir: '/tmp/sandbox',
    start: async () => {},
    stop: async () => {},
    snapshot: () => {
      snapshotCalls += 1;
      return structuredClone(needsSnap);
    },
    senseSnapshot: () => structuredClone(senseSnap),
    factStaleInMs: () => undefined,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        offSpy();
      };
    },
    registerMaintenanceSessionId: () => {},
    isMaintenanceSession: () => false,
    reportTransportResult: () => {},
    tools: {} as NeedsRuntime['tools'],
    actions: {} as NeedsRuntime['actions'],
  } satisfies NeedsRuntime;

  return {
    runtime,
    listeners,
    offSpy,
    getSnapshotCalls: () => snapshotCalls,
    emitCpu(usage: number) {
      senseSnap.state.self.body.cpu = fact({ usage, perCore: [usage], load1: 1, load5: 1, load15: 1 });
      for (const fn of [...listeners]) fn();
    },
    setPaused(paused: boolean) {
      needsSnap.paused = paused;
      senseSnap.settings.paused = paused;
    },
  };
}

describe('createFramesSource 侧栏帧流节流合并与资源清理', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('首帧立即发出，短时间高频连续更新合并为尾部单帧，超过节流窗口后再次立即响应', async () => {
    vi.useFakeTimers();
    const { runtime, emitCpu, getSnapshotCalls, listeners, offSpy } = createStubRuntime(0.12);
    const source = createFramesSource(runtime);
    const controller = new AbortController();
    const iterator = source(controller.signal)[Symbol.asyncIterator]();

    // 1. 首帧无定时器等待，立即发出
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.state.self.body.cpu.value?.usage).toBe(0.12);
    expect(getSnapshotCalls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // 2. 启动下一帧等待后，在 200ms 节流窗口内连续触发 5 次高频状态变化
    const secondPromise = iterator.next();
    let secondResolved = false;
    void secondPromise.then(() => {
      secondResolved = true;
    });

    await vi.advanceTimersByTimeAsync(15);
    emitCpu(0.2);
    await vi.advanceTimersByTimeAsync(20);
    emitCpu(0.35);
    await vi.advanceTimersByTimeAsync(30);
    emitCpu(0.5);
    await vi.advanceTimersByTimeAsync(40);
    emitCpu(0.65);
    await vi.advanceTimersByTimeAsync(40);
    emitCpu(0.88);

    // 累计仅过去 145ms (< 200ms)：中间没有构造多余深拷贝帧，且仅维持单一节流定时器
    expect(secondResolved).toBe(false);
    expect(getSnapshotCalls()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    // 推进到满 200ms 窗口：合并推送最新一次状态（0.88），只调用一次 snapshot 深拷贝
    await vi.advanceTimersByTimeAsync(DEFAULT_FRAME_THROTTLE_MS - 145);
    const second = await secondPromise;
    expect(second.done).toBe(false);
    expect(second.value?.state.self.body.cpu.value?.usage).toBe(0.88);
    expect(getSnapshotCalls()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    // 3. 静默超过节流窗口（例如正常 2s 采样间隔）后到达更新：零延迟立即推送
    const thirdPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(2_000);
    emitCpu(0.42);
    expect(vi.getTimerCount()).toBe(0);
    const third = await thirdPromise;
    expect(third.done).toBe(false);
    expect(third.value?.state.self.body.cpu.value?.usage).toBe(0.42);
    expect(getSnapshotCalls()).toBe(3);

    controller.abort();
    await iterator.return?.();
    expect(offSpy).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('在节流等待期间触发 signal.abort() 时立即清理待执行定时器与订阅，绝不泄漏', async () => {
    vi.useFakeTimers();
    const { runtime, emitCpu, listeners, offSpy } = createStubRuntime(0.1);
    const source = createFramesSource(runtime, { throttleMs: 250 });
    const controller = new AbortController();
    const iterator = source(controller.signal)[Symbol.asyncIterator]();

    await iterator.next();
    const pendingNext = iterator.next();

    await vi.advanceTimersByTimeAsync(20);
    emitCpu(0.75);
    expect(vi.getTimerCount()).toBe(1);

    // 在节流定时器尚未到期时中止连接：定时器同步归零，迭代立即结束且退订 runtime
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);

    const ended = await pendingNext;
    expect(ended.done).toBe(true);
    expect(offSpy).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('显式用户动作调用 invalidate() 时取消节流等待并立即刷新侧栏帧', async () => {
    vi.useFakeTimers();
    const { runtime, emitCpu, setPaused } = createStubRuntime(0.15);
    const source = createFramesSource(runtime, { throttleMs: 300 });
    const controller = new AbortController();
    const iterator = source(controller.signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.paused).toBe(false);

    const nextFrame = iterator.next();
    await vi.advanceTimersByTimeAsync(30);
    emitCpu(0.3);
    expect(vi.getTimerCount()).toBe(1);

    // 用户在 30ms 时点击暂停开关，Remote 末尾触发 invalidate() -> 无需等满 300ms 立即推送
    setPaused(true);
    source.invalidate?.();
    expect(vi.getTimerCount()).toBe(0);

    const flushed = await nextFrame;
    expect(flushed.done).toBe(false);
    expect(flushed.value?.paused).toBe(true);

    controller.abort();
    await iterator.return?.();
  });

  it('处理预先已中止的 signal、多订阅者独立清理及消费者慢速拉取边界', async () => {
    vi.useFakeTimers();
    const { runtime, emitCpu, getSnapshotCalls, listeners, offSpy } = createStubRuntime(0.2);
    const source = createFramesSource(runtime, { throttleMs: 200 });

    // 1. 传入预先已 aborted 的 signal：不产生帧、不订阅 runtime、不遗留定时器或监听器
    const preAborted = new AbortController();
    preAborted.abort();
    const deadIter = source(preAborted.signal)[Symbol.asyncIterator]();
    const deadRes = await deadIter.next();
    expect(deadRes.done).toBe(true);
    expect(getSnapshotCalls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
    expect(offSpy).toHaveBeenCalledTimes(0);

    // 2. 两个并发订阅者 + 慢消费者（在尚未调用第二次 next() 前发生多次更新）：
    // 中止其中一个订阅者不影响另一个订阅者按节流窗口收到最新合并帧
    const c1 = new AbortController();
    const c2 = new AbortController();
    const iter1 = source(c1.signal)[Symbol.asyncIterator]();
    const iter2 = source(c2.signal)[Symbol.asyncIterator]();

    await iter1.next();
    await iter2.next();
    expect(listeners.size).toBe(2);

    // 消费者尚未调用下一次 next() 时先推进 40ms 并连续产生两次更新
    await vi.advanceTimersByTimeAsync(40);
    emitCpu(0.55);
    emitCpu(0.91);

    const next1 = iter1.next();
    const next2 = iter2.next();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(2);

    // 订阅者 1 中途断开：仅清理订阅者 1 的定时器，订阅者 2 仍在满 200ms 时拿到 0.91
    c1.abort();
    expect((await next1).done).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(listeners.size).toBe(1);

    await vi.advanceTimersByTimeAsync(160);
    const frame2 = await next2;
    expect(frame2.done).toBe(false);
    expect(frame2.value?.state.self.body.cpu.value?.usage).toBe(0.91);
    expect(vi.getTimerCount()).toBe(0);

    // 订阅者 2 当前停在 yield 挂起点（模拟慢速 WebSocket 背压未拉取下一帧），此时直接触发 abort()：
    // 无需等待消费者调用 iterator.return()，runtime 订阅与内部回调必须立即同步清理！
    c2.abort();
    expect(listeners.size).toBe(0);
    expect(offSpy).toHaveBeenCalledTimes(2);
  });

  it('尾部合并帧发出后紧接着的新更新继续受节流保护；Remote userAction 修订号去重避免双帧重复推送', async () => {
    vi.useFakeTimers();
    const { runtime, emitCpu, getSnapshotCalls, setPaused } = createStubRuntime(0.1);
    const source = createFramesSource(runtime, { throttleMs: 200 });
    const controller = new AbortController();
    const iterator = source(controller.signal)[Symbol.asyncIterator]();

    // t=0 首帧
    await iterator.next();
    expect(getSnapshotCalls()).toBe(1);

    // t=50 更新 -> 在 t=200 尾部发出第 2 帧
    const p2 = iterator.next();
    await vi.advanceTimersByTimeAsync(50);
    emitCpu(0.4);
    await vi.advanceTimersByTimeAsync(150);
    expect((await p2).value?.state.self.body.cpu.value?.usage).toBe(0.4);
    expect(getSnapshotCalls()).toBe(2);

    // t=210（距尾部帧仅 10ms）再次更新：必须继续节流至 t=400，不能在 t=210 立即发出
    const p3 = iterator.next();
    let p3Done = false;
    void p3.then(() => {
      p3Done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    emitCpu(0.7);
    expect(p3Done).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(190);
    expect((await p3).value?.state.self.body.cpu.value?.usage).toBe(0.7);
    expect(getSnapshotCalls()).toBe(3);

    // 模拟静默 5s 后 Remote.userAction 执行（action 内已触发 runtime notify 并立即推出了新帧，随后 finally 调用 invalidate(revBefore)）：
    // 只应推送 1 帧而非重复推送第 2 帧
    const p4 = iterator.next();
    await vi.advanceTimersByTimeAsync(5_000);
    const revBefore = source.revision?.();
    setPaused(true);
    emitCpu(0.71);
    const f4 = await p4;
    expect(f4.value?.paused).toBe(true);
    expect(getSnapshotCalls()).toBe(4);

    const p5 = iterator.next();
    let p5Resolved = false;
    void p5.then(() => {
      p5Resolved = true;
    });
    source.invalidate?.(revBefore);
    await Promise.resolve();
    expect(p5Resolved).toBe(false);
    expect(getSnapshotCalls()).toBe(4);

    // 若 action 未触发 runtime notify（例如无状态变更通知），invalidate(revBeforeStillSame) 仍正常立即刷新 1 帧
    const revNoNotify = source.revision?.();
    setPaused(false);
    source.invalidate?.(revNoNotify);
    const f5 = await p5;
    expect(f5.value?.paused).toBe(false);
    expect(getSnapshotCalls()).toBe(5);

    controller.abort();
  });

  it('真实 AsiRemote 统一流与动作联动：节流生效且点击 pause / openPermissionSettings 均精确单帧刷新不双发', async () => {
    vi.useFakeTimers();
    const stub = createStubRuntime(0.25);
    stub.runtime.actions = {
      pause: async (paused: boolean) => {
        await Promise.resolve();
        stub.setPaused(paused);
        stub.emitCpu(0.26);
      },
      setSendTitles: async () => {},
      openPermissionSettings: async () => {
        await Promise.resolve();
      },
      approveHelp: async () => {},
      dismissHelp: async () => {},
      openMaintenanceSession: async () => 'asi-maint-1',
      triggerCheck: async () => {},
    };

    const ctx = new Context();
    const framesSource = createAsiFramesSource(
      {
        needs: stub.runtime,
        sleep: { panelModel: () => makeSleepScenario('healthy-vault'), subscribe: () => () => {} },
        growth: { panelModel: () => makeGrowthScenario('workshop-ready'), subscribe: () => () => {} },
        intuition: { panelModel: () => makeIntuitionScenario('intuition-healthy'), subscribe: () => () => {} },
      },
      { throttleMs: 200 },
    );
    const remote = new AsiRemote(ctx, { needsActions: stub.runtime.actions, framesSource });
    const controller = new AbortController();
    const stream = remote.frames(controller.signal)[Symbol.asyncIterator]();

    const first = await stream.next();
    expect(first.value?.needs.paused).toBe(false);
    expect(stub.getSnapshotCalls()).toBe(1);

    // 静默 3 秒后执行真实 remote.pause(true)：内部 notify 立即推送 1 帧，finally 的 invalidate(revBefore) 不产生重复第 2 帧
    const secondPromise = stream.next();
    await vi.advanceTimersByTimeAsync(3_000);
    await remote.pause(true);
    const second = await secondPromise;
    expect(second.value?.needs.paused).toBe(true);
    expect(stub.getSnapshotCalls()).toBe(2);

    const thirdPromise = stream.next();
    let thirdResolved = false;
    void thirdPromise.then(() => {
      thirdResolved = true;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(stub.getSnapshotCalls()).toBe(2);

    // 执行不触发 runtime notify 的动作 openPermissionSettings：invalidate(revBefore) 立即推送 1 帧
    await remote.openPermissionSettings();
    const third = await thirdPromise;
    expect(third.done).toBe(false);
    expect(stub.getSnapshotCalls()).toBe(3);

    controller.abort();
    expect(stub.listeners.size).toBe(0);
  });
});
