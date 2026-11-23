import type { NeedsSnapshot, SenseSnapshot } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFramesSource, DEFAULT_FRAME_THROTTLE_MS } from '../src/host/dsh/frames.js';
import type { NeedsRuntime } from '../src/host/runtime.js';
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

    // 1. 传入预先已 aborted 的 signal：不产生帧、不遗留定时器或监听器
    const preAborted = new AbortController();
    preAborted.abort();
    const deadIter = source(preAborted.signal)[Symbol.asyncIterator]();
    const deadRes = await deadIter.next();
    expect(deadRes.done).toBe(true);
    expect(getSnapshotCalls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);

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

    c2.abort();
    await iter2.return?.();
    expect(listeners.size).toBe(0);
    expect(offSpy).toHaveBeenCalledTimes(3);
  });
});
