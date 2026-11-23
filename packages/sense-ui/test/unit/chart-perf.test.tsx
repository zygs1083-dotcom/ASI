import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider, SamplingProvider } from '../../src/clock';
import { formatPercent } from '../../src/format';
import { buildSpark } from '../../src/geometry';
import { sampleHistory } from '../../src/history';
import { fact } from '../../src/mock/fixtures';
import { makeScenario } from '../../src/mock/scenarios';
import { NeedsPanel } from '../../src/NeedsPanel';
import { tick } from '../../src/preview/tick';
import { Sparkline } from '../../src/sparkline';
import type { NeedsPanelModel, NeedsPanelProps } from '../../src/view-model';

vi.mock('../../src/history', async (orig) => {
  const mod = await orig<typeof import('../../src/history')>();
  return { ...mod, sampleHistory: vi.fn(mod.sampleHistory) };
});
vi.mock('../../src/geometry', async (orig) => {
  const mod = await orig<typeof import('../../src/geometry')>();
  return { ...mod, buildSpark: vi.fn(mod.buildSpark) };
});

afterEach(cleanup);

function makeProps(model: NeedsPanelModel): NeedsPanelProps {
  return {
    model,
    onPause: vi.fn(),
    onToggleTitles: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    onApproveHelp: vi.fn(),
    onDismissHelp: vi.fn(),
    onOpenMaintenanceSession: vi.fn(),
    onTriggerCheck: vi.fn(),
  };
}

const histCalls = () => vi.mocked(sampleHistory).mock.calls.length;
const geoCalls = () => vi.mocked(buildSpark).mock.calls.length;

describe('图表渲染预算', () => {
  it('温控按 30 秒心跳判断滞后，2 秒指标仍按原周期判断', () => {
    const now = 1_700_000_000_000;
    const points = [
      { at: now - 1_000, value: 0 },
      { at: now, value: 0 },
    ];
    const draw = (age: number) => (
      <SamplingProvider value={{ paused: false, intervals: { thermal: 30_000 } }}>
        <Sparkline metric="thermal" points={points} now={now + age} label="温控" format={String} />
        <Sparkline metric="cpu" points={points} now={now + age} label="CPU" format={String} />
      </SamplingProvider>
    );
    const view = render(draw(0));
    for (const age of [13_000, 59_000, 90_000]) {
      view.rerender(draw(age));
      expect(view.container.textContent).toContain('温控最近 5 分钟趋势：当前');
      expect(view.container.textContent).toContain('CPU历史 5 分钟趋势，数据滞后');
    }
    view.rerender(draw(90_001));
    expect(view.container.textContent).toContain('温控历史 5 分钟趋势，数据滞后');
  });

  it('折叠卡片不挂明细图；纯时钟推进零重采样/零几何重建', () => {
    const m = makeScenario('healthy');
    const props = makeProps(m);
    const view = render(<NeedsPanel {...props} />);
    expect(document.querySelector('[class*="chartExpanded"]')).toBeNull();
    expect(document.querySelector('[class*="tileDetail"]')).toBeNull();
    expect(geoCalls()).toBeGreaterThan(0);

    const h0 = histCalls();
    const g0 = geoCalls();
    view.rerender(<NeedsPanel {...props} model={{ ...m, now: m.now + 1_000 }} />);
    expect(histCalls()).toBe(h0);
    expect(geoCalls()).toBe(g0);
  });

  it('仅 CPU 事实+历史变化：只有 CPU 摘要图重采样一次；开明细只加 CPU 详图', async () => {
    const m = makeScenario('healthy');
    const props = makeProps(m);
    const view = render(<NeedsPanel {...props} />);
    vi.mocked(sampleHistory).mockClear();
    vi.mocked(buildSpark).mockClear();

    const now = m.now + 1_000;
    const cpu2 = fact({ ...m.state.self.body.cpu.value!, usage: 0.9 }, { ttlMs: 30_000 });
    const m2: NeedsPanelModel = {
      ...m,
      now,
      state: {
        ...m.state,
        self: { ...m.state.self, body: { ...m.state.self.body, cpu: cpu2 } },
      },
      history: {
        ...m.history,
        cpu: [...m.history.cpu, { at: now, value: 0.9 }],
      },
    };
    view.rerender(<NeedsPanel {...props} model={m2} />);
    expect(geoCalls()).toBe(1);
    expect(histCalls()).toBe(1);

    const details = document.querySelector<HTMLDetailsElement>('details[data-tile="cpu"]')!;
    fireEvent.click(details.querySelector('summary')!);
    await waitFor(() => expect(details.querySelector('[class*="tileDetail"]')).toBeTruthy());
    expect(geoCalls()).toBe(2);
  });

  it('实际预览 tick 只重采样变化的 CPU、网络下行与 Token 图', () => {
    const m = makeScenario('healthy');
    const props = makeProps(m);
    const view = render(<NeedsPanel {...props} />);
    vi.mocked(sampleHistory).mockClear();
    vi.mocked(buildSpark).mockClear();
    const next = tick(m);
    view.rerender(<NeedsPanel {...props} model={next} />);
    const actual = vi.mocked(sampleHistory).mock.calls.map(([points]) => points);
    expect(actual).toHaveLength(3);
    expect(geoCalls()).toBe(3);
  });

  it('长时间数据滞后时标明历史锚点且不重做预处理', () => {
    const m = makeScenario('healthy');
    const points = m.history.cpu;
    const chart = (now: number) => (
      <ClockProvider value={now}>
        <Sparkline
          expanded
          points={points}
          now={m.now}
          label="CPU"
          format={formatPercent}
          severity="good"
          sampleIntervalMs={5_000}
        />
      </ClockProvider>
    );
    const view = render(chart(m.now));
    expect(view.container.textContent).toContain('现在');
    vi.mocked(sampleHistory).mockClear();
    vi.mocked(buildSpark).mockClear();
    view.rerender(chart(m.now + 15_001));
    expect(view.container.textContent).toContain('数据滞后 · 最后 15 秒前');
    expect(geoCalls()).toBe(0);
    expect(histCalls()).toBe(0);
  });
});
