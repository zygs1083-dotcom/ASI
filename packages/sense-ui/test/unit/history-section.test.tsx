import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeScenario } from '../../src/mock/scenarios';
import { MOCK_MONTHLY_2026_10 } from '../../src/mock/scenarios-history';
import { SensePanel } from '../../src/SensePanel';
import type { MonthlySummaryLoadResult, SensePanelModel, SensePanelProps } from '../../src/view-model';

afterEach(cleanup);

function makeHandlers(over: Partial<SensePanelProps> = {}): Omit<SensePanelProps, 'model'> {
  return {
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
    onListMonths: vi.fn(async () => ['2026-10', '2026-09']),
    onLoadMonthly: vi.fn(async (month: string): Promise<MonthlySummaryLoadResult> => {
      if (month === '2026-10') return { available: true, summary: MOCK_MONTHLY_2026_10 };
      return { available: false, reason: '该月份暂无归档记录' };
    }),
    onClearHistory: vi.fn(async () => {}),
    ...over,
  };
}

function renderPanel(model: SensePanelModel, over: Partial<SensePanelProps> = {}, width = 420) {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  document.body.appendChild(container);
  const handlers = makeHandlers(over);
  const res = render(<SensePanel model={model} {...handlers} />, { container });
  return { ...res, handlers, container };
}

function openHistorySection() {
  const summary = screen.getByText('历史', { selector: 'summary' });
  const details = summary.closest('details');
  if (!details) throw new Error('Expected summary inside details');
  if (!details.open) fireEvent.click(summary);
  return details;
}

describe('SensePanel 历史区块', () => {
  it('挂载在「规则」之前且默认收起，不打乱初始折叠节奏', () => {
    renderPanel(makeScenario('healthy'));
    const summaries = [...document.querySelectorAll('[data-panel] > details > summary')].map((el) =>
      el.textContent?.trim(),
    );
    expect(summaries).toEqual(['身体', '现在', '事件流', '历史', '规则']);
    expect(screen.getByText('历史', { selector: 'summary' }).closest('details')?.open).toBe(false);
    expect(screen.getByText('规则', { selector: 'summary' }).closest('details')?.open).toBe(false);
  });

  it('渲染今天/昨天日汇总切换、4 条带 min/max 阴影带的 24h 曲线与无异常离开一行文案', async () => {
    const { container } = renderPanel(makeScenario('history-ready'));
    const details = openHistorySection();

    await waitFor(() => expect(within(details).getByRole('combobox', { name: '选择月份' })).toBeTruthy());

    // 日汇总：今天（Top 5 应用、唤醒/告警/突发/睡眠/锁屏/观测时长）
    expect(within(details).getByText(/2026-11-18/)).toBeTruthy();
    expect(within(details).getByText('CodeForge')).toBeTruthy();
    expect(within(details).getByText('MailBox')).toBeTruthy();
    expect(within(details).getByText('2 次')).toBeTruthy();

    // 切换到昨天
    fireEvent.click(within(details).getByRole('button', { name: '昨天' }));
    expect(within(details).getByText(/2026-11-17/)).toBeTruthy();
    expect(within(details).queryByText('MailBox')).toBeNull();

    // 4 条 24h 走势图均带 min/max 阴影带 path
    expect(within(details).getByText('CPU')).toBeTruthy();
    expect(within(details).getByText('内存')).toBeTruthy();
    expect(within(details).getByText('磁盘可用')).toBeTruthy();
    expect(within(details).getByText('电池')).toBeTruthy();
    expect(container.querySelectorAll('[data-range-band="true"]').length).toBe(4);

    // 最近一次离开无异常
    expect(within(details).getByText('离开 2 小时，无异常')).toBeTruthy();
  });

  it('离开有异常时高亮展示异常列表与推送标记', async () => {
    renderPanel(makeScenario('history-away-anomaly'));
    const details = openHistorySection();

    const awayBox = details.querySelector('[data-anomaly="true"]') as HTMLElement;
    expect(awayBox).toBeTruthy();
    expect(within(awayBox).getByText('已推送')).toBeTruthy();
    expect(within(awayBox).getByText(/磁盘可用 注意告警 2 次/)).toBeTruthy();
    expect(within(awayBox).getByText(/外部删除 14 个文件（workspace-demo）/)).toBeTruthy();
  });

  it('月度总结覆盖加载中、无数据、失败重试与成功四态，空月份列表显示引导文案', async () => {
    // 1) 无已完成月份
    renderPanel(makeScenario('history-empty'), { onListMonths: vi.fn(async () => []) });
    let details = openHistorySection();
    await waitFor(() => expect(within(details).getByText('暂无已完成的月度总结（每月结束后生成）')).toBeTruthy());
    expect(within(details).queryByRole('combobox', { name: '选择月份' })).toBeNull();

    cleanup();

    // 2) 加载中 -> 失败 -> 重试成功 / 无数据
    let resolvePending!: (value: MonthlySummaryLoadResult) => void;
    const onLoadMonthly = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MonthlySummaryLoadResult>((resolve) => {
            resolvePending = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('月度档案校验失败'))
      .mockResolvedValueOnce({ available: true, summary: MOCK_MONTHLY_2026_10 })
      .mockResolvedValueOnce({ available: false, reason: '该月份暂无归档记录' });

    renderPanel(makeScenario('history-ready'), {
      onListMonths: vi.fn(async () => ['2026-10', '2026-09']),
      onLoadMonthly,
    });
    details = openHistorySection();
    const select = await waitFor(() => within(details).getByRole('combobox', { name: '选择月份' }));

    // 加载中态
    fireEvent.change(select, { target: { value: '2026-10' } });
    expect(within(details).getByRole('status').textContent).toContain('正在加载 2026-10 月度总结');
    resolvePending({ available: true, summary: MOCK_MONTHLY_2026_10 });
    await waitFor(() => expect(within(details).getByText(/已覆盖 29\/31 天/)).toBeTruthy());

    // 无数据态
    fireEvent.change(select, { target: { value: '2026-09' } });
    // 先触发第2次 mockRejectedValueOnce -> 验证失败态与重试恢复
    const alert = await waitFor(() => within(details).getByRole('alert'));
    expect(alert.textContent).toContain('月度档案校验失败');

    // 点击重试调用第3次 -> 成功
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(within(details).getByText(/已覆盖 29\/31 天/)).toBeTruthy());

    // 再次选 2026-09 -> 无数据态
    fireEvent.change(select, { target: { value: '2026-09' } });
    await waitFor(() => expect(within(details).getByText('该月份暂无归档记录')).toBeTruthy());
  });

  it('清除历史需二次确认：取消不调用，确认后调用并分别反馈成功与失败', async () => {
    const onClearHistory = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('磁盘不可写'));
    const onListMonths = vi.fn().mockResolvedValueOnce(['2026-10']).mockResolvedValueOnce([]);

    renderPanel(makeScenario('history-ready'), { onClearHistory, onListMonths });
    const details = openHistorySection();
    await waitFor(() => expect(within(details).getByRole('combobox', { name: '选择月份' })).toBeTruthy());

    const clearTrigger = within(details).getByRole('button', { name: '清除历史' });
    fireEvent.click(clearTrigger);

    // 二次确认说明与默认焦点在「取消」
    const dialog = within(details).getByRole('alertdialog');
    expect(dialog.textContent).toContain('30 天明细');
    expect(dialog.textContent).toContain('日汇总');
    expect(dialog.textContent).toContain('月度总结');
    expect(dialog.textContent).toContain('不可撤销');
    const cancelBtn = within(dialog).getByRole('button', { name: '取消' });
    expect(document.activeElement).toBe(cancelBtn);

    // 点击取消：不触发回调，焦点返回触发按钮
    fireEvent.click(cancelBtn);
    expect(onClearHistory).not.toHaveBeenCalled();
    expect(within(details).queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(clearTrigger);

    // 再次点击后按 Escape 同样不触发
    fireEvent.click(clearTrigger);
    const dialogEsc = within(details).getByRole('alertdialog');
    fireEvent.keyDown(dialogEsc, { key: 'Escape' });
    expect(onClearHistory).not.toHaveBeenCalled();
    expect(within(details).queryByRole('alertdialog')).toBeNull();

    // 确认清除：成功反馈且清空月度下拉
    fireEvent.click(clearTrigger);
    fireEvent.click(within(within(details).getByRole('alertdialog')).getByRole('button', { name: '确认清除' }));
    await waitFor(() => expect(onClearHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(details).getByRole('status').textContent).toContain('已清除全部历史数据'));

    // 失败反馈
    fireEvent.click(clearTrigger);
    fireEvent.click(within(within(details).getByRole('alertdialog')).getByRole('button', { name: '确认清除' }));
    await waitFor(() => expect(within(details).getByRole('alert').textContent).toContain('磁盘不可写'));
  });

  it('刚安装无历史与 280px 窄屏均正常渲染且无横向溢出', async () => {
    const emptyRes = renderPanel(makeScenario('history-empty'), { onListMonths: vi.fn(async () => []) });
    const emptyDetails = openHistorySection();
    expect(within(emptyDetails).getByText('今日暂无汇总数据')).toBeTruthy();
    expect(within(emptyDetails).getByText('暂无 24 小时指标数据')).toBeTruthy();
    expect(within(emptyDetails).getByText('暂无离开记录')).toBeTruthy();
    await waitFor(() => expect(within(emptyDetails).getByText('暂无已完成的月度总结（每月结束后生成）')).toBeTruthy());
    expect(emptyRes.container.textContent).not.toMatch(/NaN|Infinity/);

    cleanup();

    // 280px 窄屏有数据展开无横向溢出
    const ready = makeScenario('history-ready');
    const firstApp = ready.timeline?.today?.topApps[0];
    if (firstApp) firstApp.app = 'VeryLongFabricatedApplicationBundleNameForOverflowCheckDesktop';
    const { container } = renderPanel(ready, {}, 280);
    openHistorySection();
    await waitFor(() => expect(screen.getByRole('combobox', { name: '选择月份' })).toBeTruthy());
    const panel = container.querySelector('[data-panel]') as HTMLElement;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  });
});
