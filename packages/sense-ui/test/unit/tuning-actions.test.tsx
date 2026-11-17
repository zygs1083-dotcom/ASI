import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeScenario } from '../../src/mock/scenarios';
import { SensePanel } from '../../src/SensePanel';
import { defaultTuningCopy } from '../../src/sections/tuning-actions';
import { useTuningOperations } from '../../src/sections/tuning-operation';
import type { SensePanelModel, SensePanelProps } from '../../src/view-model';

afterEach(cleanup);

function setup(model: SensePanelModel) {
  const props = {
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
    onAcceptRebaseline: vi.fn(async (_id: string) => {}),
  } satisfies SensePanelProps;
  const view = render(<SensePanel {...props} />);
  fireEvent.click(screen.getByText('规则', { selector: 'summary' }));
  return { props, view };
}

describe('调参恢复与重置', () => {
  it('向用户说明共享标题可能包含主机名', () => {
    const { props } = setup(makeScenario('healthy'));
    expect(screen.getByText('标题可能包含主机名等信息。')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /窗口标题发给模型/ }));
    expect(props.onToggleTitles).toHaveBeenCalledOnce();
  });

  it('备份失败时显示原因、允许重试并阻止重置', async () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: { reason: 'restore-failed' },
      backupError: { code: 'ENOSPC', stage: 'backup' },
    };
    const retry = vi.fn(async () => {});
    const { props, view } = setup(model);
    view.rerender(<SensePanel {...props} onRetryTuningBackup={retry} />);
    expect(screen.getByText(/调参数据无法备份：磁盘空间不足/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '重置调参' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(props.onResetTuning).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it('备份成功但保存失败时同时显示文件名和错误，保存前不能关闭提示', async () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: { reason: 'restore-failed' },
      backupError: { code: 'ENOSPC', stage: 'save' },
      backupNotice: { kind: 'corrupt', fileName: 'body.json.bak-example' },
    };
    const dismiss = vi.fn(async () => {});
    const { props, view } = setup(model);
    view.rerender(<SensePanel {...props} onRetryTuningBackup={async () => {}} onDismissTuningBackup={dismiss} />);
    expect(screen.getByText(/无法保存调参恢复状态：磁盘空间不足/)).toBeTruthy();
    expect(screen.getByText(/已将损坏的调参数据备份为 body.json.bak-example/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '重置调参' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '关闭备份提示' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(
      <SensePanel
        {...props}
        onDismissTuningBackup={dismiss}
        model={{
          ...model,
          tuning: { ...model.tuning!, backupError: undefined },
        }}
      />,
    );
    expect((screen.getByRole('button', { name: '关闭备份提示' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭备份提示' }));
    expect(dismiss).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it.each([
    ['corrupt', '已将损坏的调参数据备份为 body.json.bak-example，已恢复默认'],
    ['unknown-version', '已将无法识别版本的调参数据备份为 body.json.bak-example，已恢复默认'],
  ] as const)('显示并关闭 %s 备份提示', async (kind, text) => {
    const model = makeScenario('healthy');
    model.tuning = { parameters: [], log: [], backupNotice: { kind, fileName: 'body.json.bak-example' } };
    const dismiss = vi.fn(async () => {});
    const { props, view } = setup(model);
    view.rerender(<SensePanel {...props} onDismissTuningBackup={dismiss} />);
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭备份提示' }));
    expect(dismiss).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it('长备份文件名在窄侧栏内换行', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      backupNotice: { kind: 'corrupt', fileName: 'body.json.bak-1700000000000-11111111-2222-3333-4444-555555555555' },
    };
    const { view } = setup(model);
    view.container.style.width = '280px';
    const text = screen.getByText(/已将损坏的调参数据备份为/);
    const notice = text.parentElement!;
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
  });

  it.each(['corrupt', 'unknown-version'] as const)('以英文区分 %s 备份和错误状态', async (kind) => {
    const model = makeScenario('healthy');
    const english = {
      ...defaultTuningCopy,
      backupFailed: 'Unable to back up tuning data: ',
      noSpace: 'Not enough disk space',
      retry: 'Retry',
      reset: 'Reset tuning',
      backupCorrupt: 'Corrupt tuning data was backed up as ',
      backupUnknown: 'Tuning data with an unrecognized version was backed up as ',
      restored: '; defaults restored',
      dismissBackup: 'Dismiss backup notice',
      restoreUnknown: 'Unrecognized version',
      restoreCorrupt: 'Corrupt data',
    };
    model.tuning = {
      parameters: [],
      log: [],
      disabled: { reason: 'restore-failed' },
      backupError: { code: 'ENOSPC', stage: 'backup' },
    };
    const { props, view } = setup(model);
    view.rerender(<SensePanel {...props} tuningCopy={english} onRetryTuningBackup={async () => {}} />);
    expect(screen.getByText('Unable to back up tuning data: Not enough disk space (ENOSPC)')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reset tuning' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(
      <SensePanel
        {...props}
        tuningCopy={english}
        onDismissTuningBackup={async () => {}}
        model={{
          ...model,
          tuning: {
            parameters: [],
            log: [],
            disabled: { reason: 'restore-failed' },
            backupNotice: { kind, fileName: 'body.json.bak-example' },
          },
        }}
      />,
    );
    const prefix = kind === 'corrupt' ? english.backupCorrupt : english.backupUnknown;
    expect(screen.getByText(`${prefix}body.json.bak-example; defaults restored`)).toBeTruthy();
    await act(async () => {});
  });

  it('保存失败显示恢复入口，直接调用恢复回调', async () => {
    const model = makeScenario('healthy');
    model.tuning = { parameters: [], log: [], disabled: { reason: 'storage-failed' } };
    const { props } = setup(model);
    expect(screen.getByText(/保存调参数据失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复 AI 调参' }));
    expect(props.onResumeTuning).toHaveBeenCalledOnce();
    expect(props.onResetTuning).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it('恢复失败的重置必须确认，可取消，取消后焦点返回入口', async () => {
    const model = makeScenario('healthy');
    model.tuning = { parameters: [], log: [], disabled: { reason: 'restore-failed' } };
    const { props } = setup(model);
    expect(screen.getByText('保存的调参数据损坏，AI 调参已停用')).toBeTruthy();
    const trigger = screen.getByRole('button', { name: '重置调参' });
    fireEvent.click(trigger);
    expect(props.onResetTuning).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习')).toBeTruthy();
    expect(screen.getByRole('alertdialog', { description: /将丢弃已保存的调参/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消', description: /将丢弃已保存的调参/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(document.activeElement).toBe(trigger);
    expect(props.onResetTuning).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
    expect(props.onResetTuning).toHaveBeenCalledOnce();
    expect(props.onResumeTuning).not.toHaveBeenCalled();
    await act(async () => {});
  });
});

describe('重新基线建议', () => {
  it('按指标单位显示建议，并仅在确认后传入对应 id', async () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        {
          id: 'cpu-1',
          metric: 'cpu',
          unit: 'ratio',
          slotLabel: '周二 14 时',
          from: 0.2,
          to: 0.7,
          samples: 12,
          dates: 3,
        },
        {
          id: 'net-1',
          metric: 'networkRx',
          unit: 'bytes-per-second',
          slotLabel: '周三 15 时',
          from: 1024,
          to: 2048,
          samples: 8,
          dates: 4,
        },
        {
          id: 'disk-1',
          metric: 'disk:/demo',
          unit: 'bytes',
          slotLabel: '周四 16 时',
          from: 1024 ** 3,
          to: 2 * 1024 ** 3,
          samples: 9,
          dates: 3,
        },
        {
          id: 'rss-1',
          metric: 'processRss',
          unit: 'bytes',
          slotLabel: '周五 17 时',
          from: 1024 ** 3,
          to: 2 * 1024 ** 3,
          samples: 10,
          dates: 3,
        },
        {
          id: 'bat-1',
          metric: 'battery',
          unit: 'percent',
          slotLabel: '周六 18 时',
          from: 30,
          to: 60,
          samples: 10,
          dates: 3,
        },
        {
          id: 'temp-1',
          metric: 'thermal',
          unit: 'ordinal',
          slotLabel: '周日 19 时',
          from: 0.5,
          to: 1.5,
          samples: 10,
          dates: 3,
        },
        {
          id: 'token-1',
          metric: 'tokens',
          unit: 'tokens',
          slotLabel: '周一 20 时',
          from: 1000,
          to: 2000,
          samples: 10,
          dates: 3,
        },
      ],
    };
    const { props } = setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const list = screen.getByRole('list', { name: '重新基线建议' });
    expect(list.textContent).toContain('CPU');
    expect(list.textContent).toContain('周二 14 时');
    expect(list.textContent).toContain('20%');
    expect(list.textContent).toContain('70%');
    expect(list.textContent).toContain('12 个样本');
    expect(list.textContent).toContain('3 个日期');
    expect(list.textContent).toContain('1 KB/s');
    expect(list.textContent).toContain('2 KB/s');
    expect(list.textContent).toContain('磁盘 /demo 剩余');
    expect(list.textContent).toContain('1.0 GB');
    expect(list.textContent).toContain('2.0 GB');
    expect(list.textContent).toContain('30%');
    expect(list.textContent).toContain('0.5 档');
    expect(list.textContent).toContain('Token 上下文剩余');
    expect(list.textContent).toContain('1,000');
    const items = within(list).getAllByRole('listitem');
    const button = within(items[1]!).getByRole('button', { name: '确认重新基线' });
    fireEvent.click(button);
    expect(props.onAcceptRebaseline).not.toHaveBeenCalled();
    expect(within(items[1]!).getByText('持续故障和新负载无法自动区分，请确认这是正常的新状态')).toBeTruthy();
    expect(document.activeElement).toBe(within(items[1]!).getByRole('button', { name: '取消' }));
    expect(within(items[1]!).getByRole('alertdialog', { description: /持续故障和新负载无法自动区分/ })).toBeTruthy();
    expect(
      within(items[1]!).getByRole('button', { name: '取消', description: /持续故障和新负载无法自动区分/ }),
    ).toBeTruthy();
    fireEvent.click(within(items[1]!).getByRole('button', { name: '取消' }));
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(within(items[1]!).getByRole('button', { name: '确认应用' }));
    expect(props.onAcceptRebaseline).toHaveBeenCalledExactlyOnceWith('net-1');
    await act(async () => {});
  });

  it('建议内容变化时取消已打开的确认，避免确认过期数据', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        {
          id: 'cpu-1',
          metric: 'cpu',
          unit: 'ratio',
          slotLabel: '周二 14 时',
          from: 0.2,
          to: 0.7,
          samples: 12,
          dates: 3,
        },
      ],
    };
    const { props, view } = setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重新基线' }));
    view.rerender(
      <SensePanel
        {...props}
        model={{
          ...model,
          tuning: { ...model.tuning, suggestions: [{ ...model.tuning.suggestions![0]!, to: 0.8 }] },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: '确认应用' })).toBeNull();
    expect(props.onAcceptRebaseline).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByText('重新基线建议', { selector: '[tabindex]' }));
    expect(screen.getByText(/建议已更新，请重新确认/).getAttribute('aria-live')).toBeTruthy();
  });

  it('最后一条建议消失时保留标题并通知用户', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周二', from: 0.2, to: 0.7, samples: 12, dates: 3 },
      ],
    };
    const { props, view } = setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重新基线' }));
    view.rerender(<SensePanel {...props} model={{ ...model, tuning: { ...model.tuning, suggestions: [] } }} />);
    expect(document.activeElement).toBe(screen.getByText('重新基线建议', { selector: '[tabindex]' }));
    expect(screen.getByText(/建议已更新，请重新确认/).getAttribute('aria-live')).toBeTruthy();
    expect(props.onAcceptRebaseline).not.toHaveBeenCalled();
  });

  it('连续两次失效分别通知，另一行或外部持有焦点时不抢焦点', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周一', from: 0.2, to: 0.7, samples: 8, dates: 3 },
        { id: 'memory', metric: 'memory', unit: 'ratio', slotLabel: '周二', from: 0.3, to: 0.8, samples: 8, dates: 3 },
      ],
    };
    const { props, view } = setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const triggers = screen.getAllByRole('button', { name: '确认重新基线' });
    fireEvent.click(triggers[0]!);
    fireEvent.click(triggers[1]!);
    const secondCancel = screen.getAllByRole('button', { name: '取消' })[1]!;
    expect(document.activeElement).toBe(secondCancel);
    view.rerender(
      <SensePanel
        {...props}
        model={{
          ...model,
          tuning: { ...model.tuning, suggestions: [model.tuning.suggestions![1]!] },
        }}
      />,
    );
    expect(document.activeElement).toBe(secondCancel);
    const live = screen.getByText(/建议已更新，请重新确认/);
    const firstNotice = live.textContent;
    expect(screen.getAllByRole('button', { name: '确认应用' })).toHaveLength(1);
    const pause = screen.getByRole('checkbox', { name: /暂停感知/ });
    pause.focus();
    view.rerender(<SensePanel {...props} model={{ ...model, tuning: { ...model.tuning, suggestions: [] } }} />);
    expect(document.activeElement).toBe(pause);
    expect(live.textContent).toMatch(/建议已更新，请重新确认/);
    expect(live.textContent).not.toBe(firstNotice);
  });

  it('缺失或未知单位使用原始数值和未知单位提示，包括相等均值', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 'missing', metric: 'cpu', slotLabel: '周一', from: 0.2, to: 0.7, samples: 8, dates: 3 },
        {
          id: 'unknown',
          metric: 'cpu',
          unit: 'future-unit',
          slotLabel: '周二',
          from: 42,
          to: 42,
          samples: 8,
          dates: 3,
        },
      ] as unknown as NonNullable<SensePanelModel['tuning']>['suggestions'],
    };
    setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const items = within(screen.getByRole('list', { name: '重新基线建议' })).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('0.2 单位未知 → 0.7 单位未知');
    expect(items[1]!.textContent).toContain('42 单位未知 → 42 单位未知');
  });

  it('小于 1 KB 的字节与速率不因舍入变为零', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        {
          id: 'net',
          metric: 'networkRx',
          unit: 'bytes-per-second',
          slotLabel: '周一',
          from: 1,
          to: 600,
          samples: 8,
          dates: 3,
        },
        { id: 'disk', metric: 'disk:/', unit: 'bytes', slotLabel: '周二', from: 512, to: 1024, samples: 8, dates: 3 },
      ],
    };
    setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const items = within(screen.getByRole('list', { name: '重新基线建议' })).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('1 B/s → 600 B/s');
    expect(items[1]!.textContent).toContain('512 B → 1 KB');
  });

  it('格式化后数值相同的不同均值仍显示精确差异', () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        {
          id: 'cpu',
          metric: 'cpu',
          unit: 'ratio',
          slotLabel: '周一 1 时',
          from: 0.201,
          to: 0.202,
          samples: 8,
          dates: 3,
        },
        {
          id: 'net',
          metric: 'networkRx',
          unit: 'bytes-per-second',
          slotLabel: '周一 2 时',
          from: 10,
          to: 20,
          samples: 8,
          dates: 3,
        },
        { id: 'disk', metric: 'disk:/', unit: 'bytes', slotLabel: '周一 3 时', from: 10, to: 20, samples: 8, dates: 3 },
        {
          id: 'token',
          metric: 'tokens',
          unit: 'tokens',
          slotLabel: '周一 4 时',
          from: 10001,
          to: 10002,
          samples: 8,
          dates: 3,
        },
        {
          id: 'battery',
          metric: 'battery',
          unit: 'percent',
          slotLabel: '周一 5 时',
          from: 30.1,
          to: 30.2,
          samples: 8,
          dates: 3,
        },
      ],
    };
    setup(model);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const items = within(screen.getByRole('list', { name: '重新基线建议' })).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('20.1% → 20.2%');
    expect(items[1]!.textContent).toContain('10 B/s → 20 B/s');
    expect(items[2]!.textContent).toContain('10 B → 20 B');
    expect(items[3]!.textContent).toContain('10,001 token → 10,002 token');
    expect(items[4]!.textContent).toContain('30.1% → 30.2%');
  });
});

describe('异步操作保护', () => {
  it.each(['resume', 'reset', 'accept'] as const)('%s 未决时防重，失败提示并允许重试', async (action) => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
      suggestions:
        action === 'accept'
          ? [{ id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周二', from: 0.2, to: 0.7, samples: 12, dates: 3 }]
          : [],
    };
    const { props, view } = setup(model);
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const callback = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(async () => {});
    const changed = {
      ...props,
      ...(action === 'resume' ? { onResumeTuning: callback } : {}),
      ...(action === 'reset' ? { onResetTuning: callback } : {}),
      ...(action === 'accept' ? { onAcceptRebaseline: callback } : {}),
    };
    view.rerender(<SensePanel {...changed} />);
    if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (action !== 'resume')
      fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
    const working = screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    fireEvent.click(working);
    if (action === 'accept') {
      fireEvent.click(screen.getByRole('button', { name: '规则列表' }));
      fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
      expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(callback).toHaveBeenCalledOnce();
    await act(async () => reject(new Error('failed')));
    expect(screen.getByText(/失败，请重试/)).toBeTruthy();
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (action !== 'resume')
      fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
    await act(async () => {});
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('未决的建议内容改变时，同一 id 仍被锁定且其他建议可操作', async () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周一', from: 0.2, to: 0.7, samples: 8, dates: 3 },
        { id: 'memory', metric: 'memory', unit: 'ratio', slotLabel: '周二', from: 0.3, to: 0.8, samples: 8, dates: 3 },
      ],
    };
    const { props, view } = setup(model);
    let resolve!: () => void;
    const callback = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    view.rerender(<SensePanel {...props} onAcceptRebaseline={callback} />);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    fireEvent.click(screen.getAllByRole('button', { name: '确认重新基线' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '确认应用' }));
    view.rerender(
      <SensePanel
        {...props}
        onAcceptRebaseline={callback}
        model={{
          ...model,
          tuning: {
            ...model.tuning,
            suggestions: [{ ...model.tuning.suggestions![0]!, to: 0.9 }, model.tuning.suggestions![1]!],
          },
        }}
      />,
    );
    expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认重新基线' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolve());
  });

  it.each(['resume', 'reset', 'accept'] as const)('%s 成功后等待 model 响应或超时', async (action) => {
    vi.useFakeTimers();
    try {
      const model = makeScenario('healthy');
      model.tuning = {
        parameters: [],
        log: [],
        disabled:
          action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
        suggestions:
          action === 'accept'
            ? [
                {
                  id: 'cpu',
                  metric: 'cpu',
                  unit: 'ratio',
                  slotLabel: '周二',
                  from: 0.2,
                  to: 0.7,
                  samples: 12,
                  dates: 3,
                },
              ]
            : [],
      };
      const { props, view } = setup(model);
      const callback = vi.fn(async () => {});
      view.rerender(
        <SensePanel
          {...props}
          onResumeTuning={action === 'resume' ? callback : props.onResumeTuning}
          onResetTuning={action === 'reset' ? callback : props.onResetTuning}
          onAcceptRebaseline={action === 'accept' ? callback : props.onAcceptRebaseline}
        />,
      );
      if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
      const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (action !== 'resume')
        fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
      await act(async () => {});
      expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
      act(() => vi.advanceTimersByTime(9999));
      expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText(/未确认结果，请检查状态/)).toBeTruthy();
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['resume', 'reset', 'accept'] as const)('%s 反映后回到原 model 再 resolve 仍锁定', async (action) => {
    vi.useFakeTimers();
    try {
      const model = makeScenario('healthy');
      const suggestion = {
        id: 'cpu',
        metric: 'cpu' as const,
        unit: 'ratio' as const,
        slotLabel: '周二',
        from: 0.2,
        to: 0.7,
        samples: 12,
        dates: 3,
      };
      model.tuning = {
        parameters: [],
        log: [],
        disabled:
          action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
        suggestions: action === 'accept' ? [suggestion] : [],
      };
      const { props, view } = setup(model);
      let resolve!: () => void;
      const callback = vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const changed = {
        ...props,
        ...(action === 'resume' ? { onResumeTuning: callback } : {}),
        ...(action === 'reset' ? { onResetTuning: callback } : {}),
        ...(action === 'accept' ? { onAcceptRebaseline: callback } : {}),
      };
      view.rerender(<SensePanel {...changed} />);
      if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
      const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (action !== 'resume')
        fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
      const reflected = { ...model, tuning: { ...model.tuning, disabled: undefined, suggestions: [] } };
      view.rerender(<SensePanel {...changed} model={reflected} />);
      view.rerender(<SensePanel {...changed} model={model} />);
      expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => resolve());
      expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
      act(() => vi.advanceTimersByTime(9999));
      expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText(/未确认结果，请检查状态/)).toBeTruthy();
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['resume', 'reset', 'accept'] as const)('%s resolve 后 model 更新解除锁定', async (action) => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
      suggestions:
        action === 'accept'
          ? [{ id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周二', from: 0.2, to: 0.7, samples: 12, dates: 3 }]
          : [],
    };
    const { props, view } = setup(model);
    const callback = vi.fn(async () => {});
    const changed = {
      ...props,
      ...(action === 'resume' ? { onResumeTuning: callback } : {}),
      ...(action === 'reset' ? { onResetTuning: callback } : {}),
      ...(action === 'accept' ? { onAcceptRebaseline: callback } : {}),
    };
    view.rerender(<SensePanel {...changed} />);
    if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (action !== 'resume')
      fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
    await act(async () => {});
    expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(
      <SensePanel
        {...changed}
        model={{ ...model, tuning: { ...model.tuning, disabled: undefined, suggestions: [] } }}
      />,
    );
    view.rerender(<SensePanel {...changed} model={model} />);
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['resume', 'reset', 'accept'] as const)('%s resolve 时最新 model 已反映则立即解锁', async (action) => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
      suggestions:
        action === 'accept'
          ? [{ id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周二', from: 0.2, to: 0.7, samples: 12, dates: 3 }]
          : [],
    };
    const { props, view } = setup(model);
    let resolve!: () => void;
    const callback = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    const changed = { ...props, onResumeTuning: callback, onResetTuning: callback, onAcceptRebaseline: callback };
    view.rerender(<SensePanel {...changed} />);
    if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (action !== 'resume')
      fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
    view.rerender(
      <SensePanel
        {...changed}
        model={{ ...model, tuning: { ...model.tuning, disabled: undefined, suggestions: [] } }}
      />,
    );
    await act(async () => resolve());
    view.rerender(<SensePanel {...changed} model={model} />);
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('同步抛错也会显示失败并解锁', () => {
    const model = makeScenario('healthy');
    model.tuning = { parameters: [], log: [], disabled: { reason: 'storage-failed' } };
    const { props, view } = setup(model);
    const callback = vi.fn(() => {
      throw new Error('failed');
    });
    view.rerender(<SensePanel {...props} onResumeTuning={callback} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复 AI 调参' }));
    expect(screen.getByText(/失败，请重试/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '恢复 AI 调参' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['resume', 'reset', 'accept'] as const)('%s 返回非 Promise 时显示失败并解锁', (action) => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
      suggestions:
        action === 'accept'
          ? [{ id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '周二', from: 0.2, to: 0.7, samples: 12, dates: 3 }]
          : [],
    };
    const { props, view } = setup(model);
    const bad = (() => {}) as unknown as () => Promise<void>;
    view.rerender(
      <SensePanel
        {...props}
        onResumeTuning={action === 'resume' ? bad : props.onResumeTuning}
        onResetTuning={action === 'reset' ? bad : props.onResetTuning}
        onAcceptRebaseline={action === 'accept' ? bad : props.onAcceptRebaseline}
      />,
    );
    if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (action !== 'resume')
      fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
    expect(screen.getByText(/失败，请重试/)).toBeTruthy();
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['resume', 'reset', 'accept'] as const)(
    '%s 对应行消失或原因变化后 reject 仍显示可关闭的失败',
    async (action) => {
      const model = makeScenario('healthy');
      model.tuning = {
        parameters: [],
        log: [],
        disabled:
          action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
        suggestions:
          action === 'accept'
            ? [
                {
                  id: 'cpu',
                  metric: 'cpu',
                  unit: 'ratio',
                  slotLabel: '周二',
                  from: 0.2,
                  to: 0.7,
                  samples: 12,
                  dates: 3,
                },
              ]
            : [],
      };
      const { props, view } = setup(model);
      let reject!: () => void;
      const callback = () =>
        new Promise<void>((_, fail) => {
          reject = () => fail(new Error('failed'));
        });
      const changed = { ...props, onResumeTuning: callback, onResetTuning: callback, onAcceptRebaseline: callback };
      view.rerender(<SensePanel {...changed} />);
      if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
      fireEvent.click(
        screen.getByRole('button', {
          name: action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线',
        }),
      );
      if (action !== 'resume')
        fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
      view.rerender(
        <SensePanel
          {...changed}
          model={{
            ...model,
            tuning: {
              ...model.tuning,
              suggestions: [],
              disabled: action === 'resume' ? { reason: 'restore-failed' } : undefined,
            },
          }}
        />,
      );
      await act(async () => reject());
      expect(screen.getByRole('alert').textContent).toContain('失败，请重试');
      fireEvent.click(screen.getByRole('button', { name: '关闭操作提示' }));
      expect(screen.queryByText(/失败，请重试/)).toBeNull();
    },
  );

  it.each(['resume', 'reset'] as const)('%s 原因切换后 resolve，再回到旧原因仍锁定至超时', async (action) => {
    vi.useFakeTimers();
    try {
      const model = makeScenario('healthy');
      model.tuning = {
        parameters: [],
        log: [],
        disabled: { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
      };
      const { props, view } = setup(model);
      let resolve!: () => void;
      const callback = vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const changed = { ...props, onResumeTuning: callback, onResetTuning: callback };
      view.rerender(<SensePanel {...changed} />);
      const label = action === 'resume' ? '恢复 AI 调参' : '重置调参';
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (action === 'reset') fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
      view.rerender(
        <SensePanel
          {...changed}
          model={{
            ...model,
            tuning: {
              ...model.tuning,
              disabled: { reason: action === 'resume' ? 'restore-failed' : 'storage-failed' },
            },
          }}
        />,
      );
      await act(async () => resolve());
      view.rerender(<SensePanel {...changed} model={model} />);
      const working = screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement;
      expect(working.disabled).toBe(true);
      fireEvent.click(working);
      act(() => vi.advanceTimersByTime(9999));
      expect(working.disabled).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole('alert').textContent).toContain(`${label}：未确认结果，请检查状态`);
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['resume', 'reset'] as const)('%s resolve 后原因切换并返回旧原因仍锁定', async (action) => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      disabled: { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
    };
    const { props, view } = setup(model);
    const changed = { ...props, onResumeTuning: async () => {}, onResetTuning: async () => {} };
    view.rerender(<SensePanel {...changed} />);
    const label = action === 'resume' ? '恢复 AI 调参' : '重置调参';
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (action === 'reset') fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
    await act(async () => {});
    view.rerender(
      <SensePanel
        {...changed}
        model={{
          ...model,
          tuning: { ...model.tuning, disabled: { reason: action === 'resume' ? 'restore-failed' : 'storage-failed' } },
        }}
      />,
    );
    view.rerender(<SensePanel {...changed} model={model} />);
    expect((screen.getByRole('button', { name: /处理中/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['resume', 'reset', 'accept'] as const)(
    '%s 收起规则后 reject 的提示仍可见，关闭后焦点回到规则标题',
    async (action) => {
      const model = makeScenario('healthy');
      model.tuning = {
        parameters: [],
        log: [],
        disabled:
          action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
        suggestions:
          action === 'accept'
            ? [
                {
                  id: 'cpu',
                  metric: 'cpu',
                  unit: 'ratio',
                  slotLabel: '夜间',
                  from: 0.2,
                  to: 0.7,
                  samples: 12,
                  dates: 3,
                },
              ]
            : [],
      };
      const { props, view } = setup(model);
      let reject!: () => void;
      const callback = () =>
        new Promise<void>((_, fail) => {
          reject = () => fail(new Error('failed'));
        });
      view.rerender(
        <SensePanel {...props} onResumeTuning={callback} onResetTuning={callback} onAcceptRebaseline={callback} />,
      );
      if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
      const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (action !== 'resume')
        fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
      const summary = screen.getByText('规则', { selector: 'summary' });
      fireEvent.click(summary);
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
      await act(async () => reject());
      const alert = screen.getByRole('alert');
      expect(alert.closest('details')).toBeNull();
      expect(alert.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(alert.textContent).toContain(
        action === 'accept' ? '接受 CPU 夜间 重新基线失败，请重试' : `${label}失败，请重试`,
      );
      const close = within(alert).getByRole('button', { name: '关闭操作提示' });
      close.focus();
      fireEvent.click(close);
      expect(document.activeElement).toBe(summary);
    },
  );

  it.each(['resume', 'reset', 'accept'] as const)('%s 收起规则后超时仍可见并宣布操作对象', async (action) => {
    vi.useFakeTimers();
    try {
      const model = makeScenario('healthy');
      model.tuning = {
        parameters: [],
        log: [],
        disabled:
          action === 'accept' ? undefined : { reason: action === 'resume' ? 'storage-failed' : 'restore-failed' },
        suggestions:
          action === 'accept'
            ? [
                {
                  id: 'cpu',
                  metric: 'cpu',
                  unit: 'ratio',
                  slotLabel: '夜间',
                  from: 0.2,
                  to: 0.7,
                  samples: 12,
                  dates: 3,
                },
              ]
            : [],
      };
      setup(model);
      if (action === 'accept') fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
      const label = action === 'resume' ? '恢复 AI 调参' : action === 'reset' ? '重置调参' : '确认重新基线';
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (action !== 'resume')
        fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? '确认重置' : '确认应用' }));
      fireEvent.click(screen.getByText('规则', { selector: 'summary' }));
      await act(async () => {});
      act(() => vi.advanceTimersByTime(10_000));
      const alert = screen.getByRole('alert');
      expect(alert.closest('details')).toBeNull();
      expect(alert.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(alert.textContent).toContain(
        `${action === 'accept' ? '接受 CPU 夜间 重新基线' : label}：未确认结果，请检查状态`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发建议失败各自保留原对象和独立提示', async () => {
    const model = makeScenario('healthy');
    model.tuning = {
      parameters: [],
      log: [],
      suggestions: [
        { id: 'cpu', metric: 'cpu', unit: 'ratio', slotLabel: '夜间', from: 0.2, to: 0.7, samples: 8, dates: 3 },
        { id: 'memory', metric: 'memory', unit: 'ratio', slotLabel: '白天', from: 0.3, to: 0.8, samples: 8, dates: 3 },
      ],
    };
    const { props, view } = setup(model);
    const rejects: Record<string, () => void> = {};
    const callback = (id: string) =>
      new Promise<void>((_, fail) => {
        rejects[id] = () => fail(new Error('failed'));
      });
    view.rerender(<SensePanel {...props} onAcceptRebaseline={callback} />);
    fireEvent.click(screen.getByRole('button', { name: '调整日志' }));
    for (const item of within(screen.getByRole('list', { name: '重新基线建议' })).getAllByRole('listitem')) {
      fireEvent.click(within(item).getByRole('button', { name: '确认重新基线' }));
      fireEvent.click(within(item).getByRole('button', { name: '确认应用' }));
    }
    view.rerender(
      <SensePanel
        {...props}
        onAcceptRebaseline={callback}
        model={{ ...model, tuning: { ...model.tuning, suggestions: [] } }}
      />,
    );
    await act(async () => {
      rejects.cpu!();
      rejects.memory!();
    });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      expect.stringContaining('接受 CPU 夜间 重新基线失败，请重试'),
      expect.stringContaining('接受 内存 白天 重新基线失败，请重试'),
    ]);
    fireEvent.click(within(alerts[0]!).getByRole('button', { name: '关闭操作提示' }));
    expect(screen.getByRole('alert').textContent).toContain('接受 内存 白天 重新基线失败，请重试');
  });

  it('卸载清除等待计时器，卸载后的 resolve 和 reject 不再设置计时器', async () => {
    vi.useFakeTimers();
    try {
      const model = makeScenario('healthy');
      model.tuning = { parameters: [], log: [], disabled: { reason: 'storage-failed' } };
      let resolve!: () => void;
      let reject!: () => void;
      const waiting = renderHook(() => useTuningOperations(model));
      act(() => waiting.result.current.run('resume', async () => {}, '恢复 AI 调参'));
      await act(async () => {});
      expect(vi.getTimerCount()).toBe(1);
      waiting.unmount();
      expect(vi.getTimerCount()).toBe(0);
      const late = renderHook(() => useTuningOperations(model));
      act(() => {
        late.result.current.run(
          'resume',
          () =>
            new Promise<void>((done) => {
              resolve = done;
            }),
          '恢复 AI 调参',
        );
        late.result.current.run(
          'reset',
          () =>
            new Promise<void>((_, fail) => {
              reject = () => fail(new Error('failed'));
            }),
          '重置调参',
        );
      });
      late.unmount();
      await act(async () => {
        resolve();
        reject();
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
