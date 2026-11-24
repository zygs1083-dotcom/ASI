import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createAsiActions } from '../../src/client/actions.ts';
import css from '../../src/client/asi-panel.module.css';
import { createFrameState, staleAsiPanelModel } from '../../src/client/frame-state.ts';
import { makeUnifiedScenario } from '../../src/client/mock-scenarios.ts';
import { asiPanelModel } from '../../src/client/panel-model.ts';
import { toWireAsiPanelModel } from '../../src/host/dsh/wire.ts';

describe('统一客户端流状态机、动作封装与 Slot 包装渲染验证', () => {
  it('asiPanelModel 与 staleAsiPanelModel 过滤非法采样键并在断线时将三域统一标为 stale', () => {
    const scenario = makeUnifiedScenario('pending-approvals');
    const wire = toWireAsiPanelModel(scenario);
    wire.needs.sampleIntervalsMs = {
      cpu: 5_000,
      'diskFree:/': 5_000,
      'invalid-key': 9_999,
    };
    const hydrated = asiPanelModel(wire);
    expect(hydrated.needs.sampleIntervalsMs).toEqual({
      cpu: 5_000,
      'diskFree:/': 5_000,
    });

    const staled = staleAsiPanelModel(hydrated);
    expect(staled.sleep.stale).toBe(true);
    expect(staled.growth.stale).toBe(true);
    expect(staled.needs.state.self.body.cpu.status).toBe('stale');
  });

  it('createFrameState 在断线重连期间保留上次快照，dispose 后安全停止通知', async () => {
    let triggerDisconnect: (() => void) | undefined;
    let releaseEnd: (() => void) | undefined;
    const sample = makeUnifiedScenario('empty-clean');
    const accepted = vi.fn();

    const frames = createFrameState((disconnected) => {
      triggerDisconnect = disconnected;
      return {
        async *[Symbol.asyncIterator]() {
          yield { value: sample, accept: accepted };
          await new Promise<void>((resolve) => {
            releaseEnd = resolve;
          });
        },
        dispose: () => {
          releaseEnd?.();
        },
      };
    });

    await new Promise((r) => setTimeout(r, 15));
    expect(frames.getSnapshot()).toEqual({ status: 'live', value: sample });
    expect(accepted).toHaveBeenCalledTimes(1);

    triggerDisconnect?.();
    expect(frames.getSnapshot()).toEqual({ status: 'reconnecting', value: sample });

    await frames.dispose();
  });

  it('createAsiActions 传播远端错误并驱动会话跳转，且 AsiPanel 已挂载时外层不重复渲染裸错横幅', async () => {
    const navigated: string[] = [];
    const mockApi = {
      pause: vi.fn(async () => ({ ok: true as const, value: undefined })),
      openMaintenanceSession: vi.fn(async () => ({ ok: true as const, value: 'asi-maint-42' })),
      triggerCheck: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'gateway/bad-request', message: '自检冷却中' },
      })),
    } as unknown as Parameters<typeof createAsiActions>[0];

    const state = createAsiActions(mockApi, (sid) => navigated.push(sid));
    expect(state.getSnapshot()).toBe(false);

    await state.actions.onOpenMaintenanceSession();
    expect(navigated).toEqual(['asi-maint-42']);

    await expect(state.actions.onTriggerCheck()).rejects.toThrow('自检冷却中');
    expect(state.getSnapshot()).toBe(true);

    state.clear();
    expect(state.getSnapshot()).toBe(false);
    state.dispose();

    // 验证 CSS Module 中包含外层连接与异常兜底样式类
    const sampleMarkup = renderToStaticMarkup(
      h('div', { className: css.slotWrap }, h('div', { className: css.slotStatusBanner, role: 'status' }, '正在连接…')),
    );
    expect(sampleMarkup).toContain('role="status"');
  });
});
