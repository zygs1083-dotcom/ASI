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

  it('0.3.0 外部缓存一键批准卡、动作收益账本、零收益静默熔断与高阶需求压制状态正确渲染', () => {
    const m = makeScenario('healthy');
    m.helpCards = [
      {
        id: 'help-ext-1',
        need: 'space',
        severity: 'uncomfortable',
        title: '发现可清理外部缓存：Xcode DerivedData（可释放 8.40 GB）',
        summary: '总计 9.10 GB，超 1h 可清理 8.40 GB',
        actionKind: 'clean-external-cache',
        actionTarget: 'xcode-derived-data',
        status: 'open',
        createdAt: T0 - 10_000,
        updatedAt: T0 - 5_000,
      },
    ];
    m.maintenanceSession = {
      ...m.maintenanceSession,
      circuitBrokenNeeds: ['space'],
    };
    m.actionLedger = [
      {
        need: 'space',
        action: 'clean-external-cache:xcode-derived-data',
        attempts: 2,
        effectiveCount: 2,
        successRate: 1,
        totalFreedBytes: 8_400_000_000,
        totalStoppedJobs: 0,
        totalTokensSaved: 0,
        totalSatisfactionDelta: 28,
        lastAttemptAt: T0 - 3_000,
        lastEffective: true,
      },
    ];
    m.higherOrderSuppressed = true;
    m.higherOrderSuppressionReason = 'L1 生理需求处于不适或恢复期，高阶需求已挂起';
    m.higherOrderDrives = [
      {
        key: 'asi-sleep:consolidation',
        sourceId: 'asi-sleep',
        tier: 2,
        label: '记忆离线巩固',
        satisfaction: 42,
        urgency: 58,
        zone: 'uncomfortable',
        driveActive: true,
        suppressed: true,
        suppressionReason: 'L1 生理需求处于不适或恢复期，高阶需求已挂起',
        summary: '累计 6 个会话待离线整理',
        evidence: { pendingSessions: 6 },
        updatedAt: T0,
      },
    ];
    const html = renderHtml(m);
    expect(html).toContain('批准清理外部缓存');
    expect(html).toContain('受控目标标识：xcode-derived-data（自动跳过 1 小时内活跃项）');
    expect(html).toContain('静默熔断省流中（空间）');
    expect(html).toContain('动作收益账本（历史实测）');
    expect(html).toContain('高阶需求仲裁（ctx.asiDrives）');
    expect(html).toContain('L2');
    expect(html).toContain('已压制挂起');
  });

  it('L3 asi-care 高阶静默求助卡（run-drive-action 自定义按钮文案）、三分驱动与动作收益账本标签正确渲染', () => {
    const m = makeScenario('healthy');
    m.helpCards = [
      {
        id: 'help-care-1',
        driveKey: 'asi-care:workspace_bloat',
        driveLabel: 'L3 · 闲置工作树产物膨胀',
        approveLabel: '批准清理构建产物',
        silent: true,
        severity: 'uncomfortable',
        title: '发现闲置构建产物：~/work/old-app/node_modules（1.45 GiB）',
        summary: 'Node.js 依赖目录所在工作树已闲置 12d',
        actionKind: 'run-drive-action',
        actionTarget: 'art_123456abcdef',
        status: 'open',
        createdAt: T0 - 8_000,
        updatedAt: T0 - 2_000,
      },
    ];
    m.maintenanceSession = {
      ...m.maintenanceSession,
      circuitBrokenNeeds: ['asi-care:repo_hygiene'],
    };
    m.actionLedger = [
      {
        need: 'asi-care:workspace_bloat',
        action: 'clean-workspace-artifact:node_modules',
        attempts: 1,
        effectiveCount: 1,
        successRate: 1,
        totalFreedBytes: 1_550_000_000,
        totalStoppedJobs: 0,
        totalTokensSaved: 0,
        totalSatisfactionDelta: 45,
        lastAttemptAt: T0 - 1_000,
        lastEffective: true,
      },
    ];
    m.higherOrderSuppressed = false;
    m.higherOrderDrives = [
      {
        key: 'asi-sleep:consolidation',
        sourceId: 'asi-sleep',
        tier: 2,
        label: '睡眠记忆整合',
        satisfaction: 48,
        urgency: 52,
        zone: 'uncomfortable',
        driveActive: true,
        autoMaintain: false,
        suppressed: false,
        summary: '累计 14 轮待睡眠整合（等待 10 分钟静默窗口）',
        evidence: { unconsolidatedTurns: 14 },
        updatedAt: T0,
      },
      {
        key: 'asi-care:repo_hygiene',
        sourceId: 'asi-care',
        tier: 3,
        label: '仓库与工作树卫生',
        satisfaction: 65,
        urgency: 35,
        zone: 'comfortable',
        driveActive: true,
        suppressed: false,
        summary: '工作树卫生恢复至 65%（回滞保持观察中）',
        evidence: { staleDirty: 0 },
        updatedAt: T0,
      },
      {
        key: 'asi-care:orphan_runtime',
        sourceId: 'asi-care',
        tier: 3,
        label: '僵尸进程与孤儿端口',
        satisfaction: 100,
        urgency: 0,
        zone: 'comfortable',
        driveActive: false,
        suppressed: false,
        summary: '未发现孤儿开发监听端口',
        evidence: { orphanPorts: 0 },
        updatedAt: T0,
      },
      {
        key: 'asi-care:workspace_bloat',
        sourceId: 'asi-care',
        tier: 3,
        label: '闲置工作树产物膨胀',
        satisfaction: 48,
        urgency: 52,
        zone: 'uncomfortable',
        driveActive: true,
        suppressed: false,
        summary: '1 处闲置 ≥7d 构建产物共占用 1.45 GiB',
        evidence: { idleArtifactCount: 1 },
        updatedAt: T0,
      },
    ];
    const html = renderHtml(m);
    expect(html).toContain('L3 · 闲置工作树产物膨胀 · 不适');
    expect(html).toContain('批准清理构建产物');
    expect(html).toContain('受控目标标识：art_123456abcdef（执行前二次复核活跃豁免与安全护栏）');
    expect(html).toContain('静默熔断省流中（L3 仓库与工作树卫生）');
    expect(html).toContain('L3 闲置工作树产物膨胀 · clean-workspace-artifact:node_modules');
    expect(html).toContain('等待静默窗口');
    expect(html).toContain('恢复至 70% 前保持驱动');
    expect(html).toContain('自维护驱动中');
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
