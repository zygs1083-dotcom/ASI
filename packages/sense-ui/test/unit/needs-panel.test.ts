import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { makeNeed, makeNeeds, T0 } from '../../src/mock/fixtures';
import { makeScenario, SCENARIOS } from '../../src/mock/scenarios';
import { NeedsPanel } from '../../src/NeedsPanel';
import { diskDropRateBadge } from '../../src/sections/disk-rows';
import type { NeedsPanelModel } from '../../src/view-model';

function renderHtml(model: NeedsPanelModel): string {
  return renderToStaticMarkup(
    createElement(NeedsPanel, {
      model,
      onPause: vi.fn(),
      onToggleTitles: vi.fn(),
      onOpenPermissionSettings: vi.fn(),
      onApproveHelp: vi.fn(),
      onDismissHelp: vi.fn(),
      onOpenMaintenanceSession: vi.fn(),
      onTriggerCheck: vi.fn(),
    }),
  );
}

describe('NeedsPanel SSR 契约验证', () => {
  it.each(SCENARIOS)('场景 %s 无异常渲染且包含五大生存需求', (name) => {
    const html = renderHtml(makeScenario(name));
    expect(html).toContain('生存需求');
    expect(html).toContain('仅本机');
    for (const label of ['能量', '空间', '内存与进程', '心智容量', '体温负荷']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('自发维护');
    expect(html).toContain('核心体征');
    expect(html).toContain('当前环境');
    expect(html).toContain('控制与隐私');
    // 已移除的旧版事件规则与历史调参界面不得残留
    expect(html).not.toContain('事件流');
    expect(html).not.toContain('调整日志');
    expect(html).not.toContain('全盘文件监视');
    expect(html).not.toContain('基线学习');
  });

  it('稳态回滞（65% 舒适但 driveActive=true）明确提示恢复至 70% 前保持驱动', () => {
    const m = makeScenario('healthy');
    m.needs = makeNeeds({
      memory: makeNeed('memory', 65, '内存回落至 65%，继续观察直至恢复舒适线', {
        zone: 'comfortable',
        driveActive: true,
      }),
    });
    const html = renderHtml(m);
    expect(html).toContain('稳态恢复中（回滞保持）');
    expect(html).toContain('恢复至 70% 前保持驱动');
  });

  it('open 求助卡置顶渲染动作按钮，resolved/dismissed 求助卡不再展示', () => {
    const openHtml = renderHtml(makeScenario('rapid-change'));
    expect(openHtml).toContain('啼哭求助（1）');
    expect(openHtml).toContain('磁盘空间即将耗尽，需人工释放大文件');
    expect(openHtml).toContain('我已处理');
    expect(openHtml).toContain('忽略');

    const resolvedModel = makeScenario('rapid-change');
    resolvedModel.helpCards = resolvedModel.helpCards.map((c) => ({ ...c, status: 'resolved' }));
    const resolvedHtml = renderHtml(resolvedModel);
    expect(resolvedHtml).not.toContain('啼哭求助（');
    expect(resolvedHtml).not.toContain('磁盘空间即将耗尽');
  });

  it('低电量与网关失联场景展示节能模式徽标与本能反射状态', () => {
    const html = renderHtml(makeScenario('low-energy'));
    expect(html).toContain('节能模式');
    expect(html).toContain('节能降频中');
    expect(html).toContain('失联（已探活 3 次）');
    expect(html).toContain('本能反射');
  });

  it('sendTitles=false 时隐藏窗口标题，不把标题或窗口拒绝原因写入 DOM', () => {
    const m = { ...makeScenario('healthy'), sendTitles: false };
    const html = renderHtml(m);
    expect(html).toContain('标题已隐藏');
    expect(html).not.toContain('demo.ts — project');
  });
});

describe('diskDropRateBadge 5 分钟磁盘骤降徽标', () => {
  it('下降速率 ≤ -100 MB/分 且跨度 ≥30s 时返回每分钟负变化量', () => {
    const badge = diskDropRateBadge(
      [
        { at: T0 - 60_000, value: 20 * 1024 ** 3 },
        { at: T0, value: 18 * 1024 ** 3 },
      ],
      T0,
    );
    expect(badge).toBe('−2.0 GB/分');
  });

  it('平稳、上涨或跨度不足 30s 时不显示徽标', () => {
    expect(
      diskDropRateBadge(
        [
          { at: T0 - 60_000, value: 20 * 1024 ** 3 },
          { at: T0, value: 20 * 1024 ** 3 - 10 * 1024 ** 2 },
        ],
        T0,
      ),
    ).toBeUndefined();
    expect(
      diskDropRateBadge(
        [
          { at: T0 - 10_000, value: 20 * 1024 ** 3 },
          { at: T0, value: 15 * 1024 ** 3 },
        ],
        T0,
      ),
    ).toBeUndefined();
  });
});
