import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fact, makeState } from '../../src/mock/fixtures';
import { makeScenario } from '../../src/mock/scenarios';
import { NeedsPanel } from '../../src/NeedsPanel';
import type { NeedsPanelModel, NeedsPanelProps } from '../../src/view-model';

afterEach(cleanup);

function makeProps(model: NeedsPanelModel, over: Partial<NeedsPanelProps> = {}): NeedsPanelProps {
  return {
    model,
    onPause: vi.fn(),
    onToggleTitles: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    onApproveHelp: vi.fn(async () => {}),
    onDismissHelp: vi.fn(async () => {}),
    onOpenMaintenanceSession: vi.fn(async () => {}),
    onTriggerCheck: vi.fn(async () => {}),
    ...over,
  };
}

function renderPanel(model: NeedsPanelModel, over: Partial<NeedsPanelProps> = {}) {
  const props = makeProps(model, over);
  const view = render(<NeedsPanel {...props} />);
  return { props, view };
}

function openSection(name: string): HTMLDetailsElement {
  const summary = screen.getByText(name, { selector: 'summary' });
  const details = summary.closest('details')!;
  if (!details.open) fireEvent.click(summary);
  return details;
}

async function openTile(key: string): Promise<HTMLDetailsElement> {
  const details = document.querySelector<HTMLDetailsElement>(`details[data-tile="${key}"]`)!;
  if (!details.open) fireEvent.click(details.querySelector('summary')!);
  await waitFor(() => expect(details.querySelector('[class*="tileDetail"]')).toBeTruthy());
  return details;
}

describe('结构与分区', () => {
  it.each([320, 420, 1100])('面板在 %ipx 宽的固定高度容器中滚动到底且没有横向溢出', (width) => {
    const { container } = render(
      <div style={{ display: 'flex', flexDirection: 'column', width, height: 400 }}>
        <NeedsPanel {...makeProps(makeScenario('healthy'))} />
      </div>,
    );
    const panel = container.querySelector<HTMLElement>('[data-panel]')!;
    expect(panel.clientHeight).toBe(400);
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    panel.scrollTop = panel.scrollHeight;
    expect(panel.scrollTop).toBeGreaterThan(0);
    const controls = within(panel).getByText('控制与隐私', { selector: 'summary' });
    expect(controls.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom);
  });

  it.each([320, 420, 1100])('位置链在 %ipx 宽时完整显示且不重叠', (width) => {
    const state = makeState();
    state.env.where.model = fact({ provider: 'demo', endpoint: 'https://model.example.test/v1', local: false });
    state.env.where.harness = fact({ host: 'harness-example-host', os: 'demo', pid: 1 });
    state.env.where.observed = fact({ host: 'observed-example-host', userSession: 'demo' });
    state.env.where.toolExec = fact({ host: 'tool-example-host', cwd: '/demo' });
    const { container } = render(
      <div style={{ width }}>
        <NeedsPanel {...makeProps({ ...makeScenario('healthy'), state })} />
      </div>,
    );
    const chain = container.querySelector<HTMLElement>('[aria-label="位置链"]')!;
    const nodes = [...chain.querySelectorAll<HTMLElement>('[class*="locNode"]')];
    expect(nodes).toHaveLength(4);
    for (const node of nodes) {
      expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth);
    }
  });

  it('生存需求/自发维护/核心体征/当前环境默认展开，控制与隐私默认收起', () => {
    renderPanel(makeScenario('healthy'));
    expect(screen.getByRole('heading', { name: '生存需求' })).toBeTruthy();
    for (const name of ['生存需求', '自发维护', '核心体征', '当前环境']) {
      expect(screen.getByText(name, { selector: 'summary' }).closest('details')!.open).toBe(true);
    }
    expect(screen.getByText('控制与隐私', { selector: 'summary' }).closest('details')!.open).toBe(false);
  });

  it('求助卡支持一键批准与忽略，操作失败展示可关闭告警', async () => {
    const onApproveHelp = vi.fn(async () => {
      throw new Error('simulated failure');
    });
    const onDismissHelp = vi.fn(async () => {});
    renderPanel(makeScenario('rapid-change'), { onApproveHelp, onDismissHelp });
    fireEvent.click(screen.getByRole('button', { name: '我已处理' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('失败');
    fireEvent.click(within(alert).getByRole('button', { name: '关闭操作提示' }));
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    await waitFor(() => expect(onDismissHelp).toHaveBeenCalledWith('help-space-1'));
  });

  it('自发维护支持查看后台会话与立即自检', async () => {
    const { props } = renderPanel(makeScenario('healthy'));
    fireEvent.click(screen.getByRole('button', { name: '查看自维护会话' }));
    await waitFor(() => expect(props.onOpenMaintenanceSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '立即自检' }));
    await waitFor(() => expect(props.onTriggerCheck).toHaveBeenCalledOnce());
  });

  it('暂停与窗口标题隐私开关触发回调', () => {
    const { props } = renderPanel(makeScenario('healthy'));
    openSection('控制与隐私');
    fireEvent.click(screen.getByText('暂停感知与自维护').closest('label')!.querySelector('input')!);
    expect(props.onPause).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('窗口标题发给模型').closest('label')!.querySelector('input')!);
    expect(props.onToggleTitles).toHaveBeenCalledWith(false);
  });

  it('展开卡片包含来源与参考线，台式机电池 null 时隐藏电池卡片', async () => {
    const { view } = renderPanel(makeScenario('healthy'));
    const details = await openTile('cpu');
    expect(within(details).getByText(/来源/)).toBeTruthy();
    expect(within(details).getByText('参考线')).toBeTruthy();
    view.unmount();

    renderPanel(makeScenario('desktop-no-battery'));
    expect(document.querySelector('details[data-tile="battery"]')).toBeNull();
  });

  it('0.3.0 外部缓存求助卡一键批准、动作收益账本与高阶需求仲裁在 320px 无横向溢出且触发回调', async () => {
    const onApproveHelp = vi.fn(async () => {});
    const { container } = render(
      <div style={{ display: 'flex', flexDirection: 'column', width: 320, height: 520 }}>
        <NeedsPanel {...makeProps(makeScenario('external-cache-arbitration'), { onApproveHelp })} />
      </div>,
    );
    const panel = container.querySelector<HTMLElement>('[data-panel]')!;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(screen.getByText(/受控目标标识：xcode-derived-data/)).toBeTruthy();
    expect(screen.getByText('动作收益账本（历史实测）')).toBeTruthy();
    expect(screen.getByText('高阶需求仲裁（ctx.asiDrives）')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '批准清理外部缓存' }));
    await waitFor(() => expect(onApproveHelp).toHaveBeenCalledWith('help-ext-cache-1'));
  });
});
