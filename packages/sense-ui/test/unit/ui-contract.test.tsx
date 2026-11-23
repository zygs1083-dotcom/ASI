import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveStatus } from '../../src/health';
import { disksFixture, fact, T0 } from '../../src/mock/fixtures';
import { makeScenario } from '../../src/mock/scenarios';
import { NeedsPanel } from '../../src/NeedsPanel';
import type { NeedsPanelModel, NeedsPanelProps } from '../../src/view-model';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderPanel(model: NeedsPanelModel) {
  const props: NeedsPanelProps = {
    model,
    onPause: vi.fn(),
    onToggleTitles: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    onApproveHelp: vi.fn(),
    onDismissHelp: vi.fn(),
    onOpenMaintenanceSession: vi.fn(),
    onTriggerCheck: vi.fn(),
  };
  return { props, view: render(<NeedsPanel {...props} />) };
}

function openDiskTile() {
  const tile = document.querySelector('details[data-tile="disks"]')! as HTMLDetailsElement;
  act(() => {
    tile.open = true;
    fireEvent(tile, new Event('toggle'));
  });
  return tile;
}

describe('事实状态与单调期限契约', () => {
  it('无剩余期限时信任 status，不根据墙钟或 TTL 判过期', () => {
    const f = fact(1, { ageMs: 6_000, ttlMs: 5_000 });
    expect(effectiveStatus(f, T0 + 61_000)).toBe('ok');
    expect(effectiveStatus({ ...f, status: 'stale' }, T0 - 61_000)).toBe('stale');
  });

  it('墙钟前跳 61 秒后普通事实与磁盘仍保持新鲜', () => {
    const model = makeScenario('healthy');
    model.state.self.body.cpu = fact({ usage: 0.92, perCore: [0.92], load1: 1, load5: 1, load15: 1 });
    model.state.self.body.disks = disksFixture([
      { mount: '/', total: 100, free: 2, status: 'ok', observedAt: T0 - 1_000, ttlMs: 5_000 },
    ]);
    const { props, view } = renderPanel(model);
    view.rerender(<NeedsPanel {...props} model={{ ...model, now: T0 + 61_000 }} />);
    for (const key of ['cpu', 'disks']) {
      const tile = document.querySelector(`details[data-tile="${key}"]`)!;
      expect(tile.getAttribute('data-sev')).toBe('critical');
      expect(tile.querySelector('[data-status="stale"]')).toBeNull();
    }
    expect(screen.getByText('Terminal')).toBeTruthy();
  });

  it('剩余单调期限到期后自动更新普通事实、磁盘卷和总览，且不污染原 model', () => {
    vi.useFakeTimers();
    const model = makeScenario('healthy');
    model.state.self.body.cpu = {
      ...fact({ usage: 0.92, perCore: [0.92], load1: 1, load5: 1, load15: 1 }),
      staleInMs: 5_000,
    };
    model.state.self.body.disks = disksFixture([{ mount: '/', total: 100, free: 2, status: 'ok', staleInMs: 5_000 }]);
    model.state.env.frontApp = { ...model.state.env.frontApp, staleInMs: 5_000 };
    renderPanel(model);
    expect(document.querySelector('details[data-tile="cpu"]')?.getAttribute('data-sev')).toBe('critical');
    act(() => vi.advanceTimersByTime(4_999));
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector('details[data-tile="cpu"] [data-status="stale"]')?.textContent).toContain('6 秒前');
    expect(document.querySelector('details[data-tile="disks"] [data-status="stale"]')).toBeTruthy();
    expect(document.querySelector('[class*="monitor"][data-sev]')?.getAttribute('data-sev')).toBe('unknown');
    expect(model.state.self.body.cpu.status).toBe('ok');
    expect(model.state.self.body.disks.value?.[0]?.status).toBe('ok');
  });

  it('父级单调期限到期不影响显式新鲜卷', () => {
    vi.useFakeTimers();
    const model = makeScenario('healthy');
    model.state.self.body.disks = {
      ...disksFixture([
        { mount: '/', total: 100, free: 80 },
        { mount: '/data', total: 100, free: 2, status: 'ok' },
      ]),
      staleInMs: 5_000,
    };
    renderPanel(model);
    const tile = openDiskTile();
    act(() => vi.advanceTimersByTime(5_000));
    expect(tile.getAttribute('data-sev')).toBe('critical');
    expect(tile.querySelector('[class*="detailFact"]')!.textContent).not.toContain('已过期');
    expect(tile.querySelector('[data-metric="disk:/"]')!.textContent).toContain('上次读数');
    expect(tile.querySelector('[data-metric="disk:/data"]')!.textContent).toContain('当前');
  });

  it('卸载时清理尚未到期的倒计时', () => {
    vi.useFakeTimers();
    const model = makeScenario('healthy');
    model.state.self.body.cpu = { ...model.state.self.body.cpu, staleInMs: 10_000 };
    const { view } = renderPanel(model);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
