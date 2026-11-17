import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fact } from '../../src/mock/fixtures';
import { makeScenario } from '../../src/mock/scenarios';
import { SensePanel } from '../../src/SensePanel';
import type { SensePanelModel, SensePanelProps } from '../../src/view-model';

afterEach(cleanup);

function renderPanel(model: SensePanelModel) {
  const props: SensePanelProps = {
    model,
    onToggleRule: vi.fn(),
    onConfirmRule: vi.fn(),
    onDeleteRule: vi.fn(),
    onPause: vi.fn(),
    onToggleTitles: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    onRevertTuning: vi.fn(),
    onLockParam: vi.fn(),
    onFeedback: vi.fn(),
    onResumeTuning: vi.fn(async () => {}),
    onResetTuning: vi.fn(async () => {}),
    onAcceptRebaseline: vi.fn(async () => {}),
  };
  render(<SensePanel {...props} />);
}

describe('电池状态文案', () => {
  it.each([
    ['满电接电', { percent: 100, charging: false, powerState: 'charged', minutesLeft: 0 }, '已充满 · 接通电源'],
    [
      '充电估计',
      { percent: 40, charging: true, powerState: 'charging', minutesLeft: 70 },
      '充电中 · 约 1 小时 10 分 后充满',
    ],
    ['充电估算中', { percent: 40, charging: true, powerState: 'charging' }, '充电中 · 估算中'],
    [
      '电池续航',
      { percent: 85, charging: false, powerState: 'battery', minutesLeft: 205 },
      '未充电 · 约剩 3 小时 25 分',
    ],
    ['电池估算中', { percent: 55, charging: false, powerState: 'battery' }, '未充电 · 估算中'],
    ['接电暂停充电', { percent: 80, charging: false, powerState: 'external', minutesLeft: 30 }, '未充电 · 接通电源'],
    [
      '接电暂停且无估计',
      { percent: 80, charging: false, powerState: 'external', estimatePending: true },
      '未充电 · 接通电源 · 估算中',
    ],
    [
      '异常电池读数',
      { percent: 55, charging: true, powerState: 'battery', minutesLeft: Number.NaN },
      '未充电 · 估算中',
    ],
    ['来源未知', { percent: 80, charging: false, minutesLeft: 30 }, '未充电'],
  ])('%s', (_name, battery, expected) => {
    const model = makeScenario('healthy');
    model.state.self.body.battery = fact(battery);
    renderPanel(model);
    const summary = document.querySelector('details[data-tile="battery"] summary')!;
    expect(summary.textContent).toContain(expected);
    if (!expected.includes('约剩')) expect(summary.textContent).not.toContain('约剩');
  });

  it('过期读数不显示当前续航或充满估计', () => {
    const model = makeScenario('healthy');
    const battery = { percent: 40, charging: true, powerState: 'charging', minutesLeft: 70 };
    model.state.self.body.battery = fact(battery, { status: 'stale' });
    renderPanel(model);
    const summary = document.querySelector('details[data-tile="battery"] summary')!;
    expect(summary.textContent).toContain('已过期');
    expect(summary.textContent).not.toContain('后充满');
  });
});

describe('Token 不可用原因', () => {
  it.each([
    ['unknown', '没有活动会话'],
    ['unavailable', '会话中尚未收到用量'],
    ['unavailable', '用量读取失败'],
  ] as const)('%s 在卡片和明细显示 %s', async (status, reason) => {
    const model = makeScenario('healthy');
    model.state.self.body.tokens = fact(null, { status, reason });
    renderPanel(model);
    const tile = document.querySelector('details[data-tile="tokens"]')!;
    expect(tile.querySelector('summary')!.textContent).toContain(reason);
    fireEvent.click(tile.querySelector('summary')!);
    await waitFor(() => expect(tile.querySelector('[class*="detailFact"]')?.textContent).toContain(reason));
  });
});
