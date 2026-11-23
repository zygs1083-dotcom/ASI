import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disksFixture, emptyFact, fact, makeBody, makeState } from '../../src/mock/fixtures';
import { makeScenario } from '../../src/mock/scenarios';
import { NeedsPanel } from '../../src/NeedsPanel';
import type { NeedsPanelModel, NeedsPanelProps } from '../../src/view-model';

afterEach(cleanup);

function renderPanel(model: NeedsPanelModel, over: Partial<NeedsPanelProps> = {}) {
  const props: NeedsPanelProps = {
    model,
    onPause: vi.fn(),
    onToggleTitles: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    onApproveHelp: vi.fn(),
    onDismissHelp: vi.fn(),
    onOpenMaintenanceSession: vi.fn(),
    onTriggerCheck: vi.fn(),
    ...over,
  };
  const view = render(<NeedsPanel {...props} />);
  return { props, view };
}

async function openTile(key: string): Promise<HTMLElement> {
  const el = document.querySelector(`details[data-tile="${key}"]`)!;
  if (!(el as HTMLDetailsElement).open) {
    fireEvent.click(el.querySelector('summary')!);
  }
  await waitFor(() => expect(el.querySelector('[class*="tileDetail"]')).toBeTruthy());
  return el as HTMLElement;
}

describe('过期保留值与隐私消毒', () => {
  it('空磁盘在摘要及明细均按磁盘契约显示未知', async () => {
    for (const disks of [disksFixture(null, { status: 'unavailable' }), disksFixture([], { status: 'ok' })]) {
      const state = makeState();
      state.self.body.disks = disks;
      const { view } = renderPanel({ ...makeScenario('healthy'), state });
      const tile = await openTile('disks');
      expect(tile.querySelector('summary')!.textContent).toContain('未知');
      expect(tile.querySelector('[class*="detailFact"]')!.textContent).toContain('未知');
      view.unmount();
    }
  });

  it('CPU 过期但保留值：摘要仍显示值 + 已过期年龄 + 未知标签', () => {
    const state = makeState();
    state.self.body.cpu = fact(
      { usage: 0.3, perCore: [0.1, 0.2], load1: 0, load5: 0, load15: 0 },
      { status: 'stale', ageMs: 120_000 },
    );
    renderPanel({ ...makeScenario('healthy'), state });
    const tile = document.querySelector('details[data-tile="cpu"]')!;
    const summary = tile.querySelector('summary')!;
    expect(summary.textContent).toContain('30%');
    expect(summary.textContent).toContain('已过期');
    expect(summary.textContent).toContain('120 秒前');
    expect(within(tile as HTMLElement).getByText('未知')).toBeTruthy();
  });

  it('sendTitles=false 时窗口 denied reason / 不可用保留标题都不进 DOM', () => {
    const state = makeState();
    state.env.focusedWindow = emptyFact('denied', 'PrivateWindowSecret 未授权');
    const { view } = renderPanel({
      ...makeScenario('healthy'),
      state,
      sendTitles: false,
    });
    expect(document.body.innerHTML).not.toContain('PrivateWindowSecret');
    expect(screen.getByText('标题已隐藏')).toBeTruthy();
    view.unmount();

    const s2 = makeState();
    s2.env.focusedWindow = fact({ title: 'thatsecret' }, { status: 'unavailable' });
    renderPanel({ ...makeScenario('healthy'), state: s2, sendTitles: false });
    expect(document.body.innerHTML).not.toContain('thatsecret');
  });

  it('contextWindow 回退估值降饱和且不产容量底线', async () => {
    const s = makeState();
    s.self.body.tokens = fact({ ...s.self.body.tokens.value!, contextWindowSource: 'fallback' });
    renderPanel({ ...makeScenario('healthy'), state: s });
    const tile = document.querySelector('details[data-tile="tokens"]')!;
    expect(tile.getAttribute('data-sev')).toBe('unknown');
    expect(tile.textContent).toContain('容量未确认');
    expect(tile.querySelector('[data-unconfirmed]')).toBeTruthy();
    expect((await openTile('tokens')).querySelectorAll('[class*="metricBlock"] line[data-threshold]')).toHaveLength(0);
  });

  it('stale token/battery 清除全部当前投影', async () => {
    const state = makeState();
    state.self.body.tokens = fact(
      {
        ...makeBody().tokens.value!,
        contextWindowSource: 'configured',
        contextUsed: 100_000,
        contextProjected: 130_000,
        compressionThreshold: 115_200,
        contextGrowthPerMinute: 720,
      },
      { status: 'stale', ageMs: 120_000, ttlMs: 5_000 },
    );
    renderPanel({ ...makeScenario('healthy'), state });
    const tokens = document.querySelector('details[data-tile="tokens"]')!;
    for (const w of ['预计下次', '下次请求', '按当前速度', '压缩']) {
      expect(tokens.textContent).not.toContain(w);
    }
    const detail = await openTile('tokens');
    expect(detail.querySelectorAll('line[data-threshold]')).toHaveLength(0);
  });

  it('磁贴渲染隔离：无关更新与纯时钟推进不重渲 CPU 卡片', () => {
    const m = makeScenario('healthy');
    const spy = vi.spyOn(m.state.self.body.cpu.value!.perCore, 'map');
    const { view, props } = renderPanel(m);
    const base = spy.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    const body2 = { ...m.state.self.body };
    body2.memory = fact({ total: 32e9, used: 20e9, pressure: 'warn', swapUsed: 0 });
    view.rerender(
      <NeedsPanel
        {...props}
        model={{ ...m, now: m.now + 1_000, state: { ...m.state, self: { ...m.state.self, body: body2 } } }}
      />,
    );
    expect(spy.mock.calls.length).toBe(base);
  });
});
