import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const SCENARIOS = ['homeostasis-healthy', 'pending-approvals', 'critical-suppressed', 'empty-clean'] as const;
const THEMES = ['light', 'dark'] as const;
const TABS = ['care', 'memory', 'skills'] as const;

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function openUnifiedPanel(page: Page, scenario: string, theme: string, tab = 'care') {
  await page.goto(`/?scenario=${scenario}&theme=${theme}&tab=${tab}`);
  await page.getByTestId('asi-unified-panel').waitFor();
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function axeCheck(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (o?: unknown) => Promise<{ violations: { impact: string; id: string }[] }> };
      }
    ).axe;
    return axe.run({ resultTypes: ['violations'] });
  });
  expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}:${v.impact}`))).toEqual([]);
}

test.describe('ASI 统一侧栏面板 320px 响应式、明暗双主题与 axe 无障碍矩阵验证', () => {
  for (const scenario of SCENARIOS) {
    for (const theme of THEMES) {
      test(`${scenario} · ${theme} · 320px 三大 Tab（含展开低频抽屉）零水平溢出且零 axe 违规`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width: 320, height: 920 });
        await openUnifiedPanel(page, scenario, theme, 'care');

        for (const tab of TABS) {
          await page.getByTestId(`asi-main-tab-${tab}`).click();
          await expect(page.getByTestId(`tabpanel-${tab}`)).toBeVisible();
          await expectNoOverflow(page);
          await axeCheck(page);
        }

        // 切回「稳态看护」验证默认收起的三个低频抽屉展开后在 320px 下同样零溢出、零 axe 违规
        await page.getByTestId('asi-main-tab-care').click();
        for (const drawerId of ['drawer-ledger', 'drawer-body', 'drawer-env']) {
          const drawer = page.getByTestId(drawerId);
          await expect(drawer).not.toHaveAttribute('open', '');
          await drawer.locator('> summary').click();
          await expect(drawer).toHaveAttribute('open', '');
        }
        await expectNoOverflow(page);
        await axeCheck(page);
        expect(errors).toEqual([]);
      });
    }
  }

  test('顶部全局状态胶囊、快捷设置弹出层、键盘 Tab 切换与跨 Tab 待批焦点条交互全链路验证', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 940 });
    await openUnifiedPanel(page, 'pending-approvals', 'dark', 'care');

    // 1. 顶部全局状态胶囊与快捷设置弹出层
    await expect(page.getByTestId('global-status-capsule')).toBeVisible();
    await page.getByTestId('quick-settings-btn').click();
    const popover = page.getByTestId('quick-settings-popover');
    await expect(popover).toBeVisible();
    await axeCheck(page);

    await page.getByTestId('global-pause-toggle').check();
    await expect(page.getByTestId('global-status-capsule')).toContainText('已暂停');
    await page.getByTestId('global-pause-toggle').uncheck();

    // 2. 在「稳态看护」页：顶部焦点条自动提示跨 Tab 的「新技能草案待审」
    await expect(page.getByTestId('spotlight-draft-banner')).toContainText('playwright-contrast-guard');

    // 3. 键盘方向键切换 Tab：care -> ArrowRight -> memory
    const careTab = page.getByTestId('asi-main-tab-care');
    await careTab.focus();
    await careTab.press('ArrowRight');
    await expect(page.getByTestId('tabpanel-memory')).toBeVisible();

    // 在「记忆库」页：跨 Tab 焦点条同时展示待处理求助卡与待审技能草案，支持一键直接批准！
    await expect(page.getByTestId('spotlight-help-banner')).toBeVisible();
    await expect(page.getByTestId('spotlight-draft-banner')).toBeVisible();

    await page.getByTestId('spotlight-approve-help').click();
    await expect(page.getByTestId('spotlight-feedback')).toContainText('已完成');

    // 点击「审阅草案」一键跳转至「技能工坊 -> 待审草案」
    await page.getByTestId('spotlight-jump-skills').click();
    await expect(page.getByTestId('tabpanel-skills')).toBeVisible();
    await expect(page.locator('[data-draft-id="draft_rev_v2"]')).toBeVisible();

    await expectNoOverflow(page);
    await axeCheck(page);
    expect(errors).toEqual([]);
  });

  test('「记忆库」Tab 完整检索、分类筛选、置顶/FSRS、CRUD 与立即睡眠整合验证', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 940 });
    await openUnifiedPanel(page, 'pending-approvals', 'light', 'memory');

    await expect(page.getByText('已置顶 · 永不衰减').first()).toBeVisible();
    await expect(page.getByText(/FSRS 保留 \d+%/).first()).toBeVisible();

    // 分类筛选
    await page.getByRole('button', { name: /^踩坑/ }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await page.getByRole('button', { name: /^全部/ }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(4);

    // 搜索与清空
    const searchInput = page.getByTestId('memory-search-input');
    await searchInput.fill('esbuild');
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await page.getByRole('button', { name: '清空搜索词' }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(4);

    // 新建记忆（含长正文展开收起）
    await page.getByTestId('new-memory-btn').click();
    await axeCheck(page);
    const createForm = page.getByTestId('create-memory-form');
    await createForm.getByLabel('标题').fill('统一侧栏设计约定');
    await createForm.getByLabel('详细内容').fill('主卡片保持精简留白，低频体征与日志按需展开。'.repeat(9));
    await createForm.getByLabel('标签（逗号分隔）').fill('ui, unified');
    await createForm.getByRole('button', { name: '保存记忆' }).click();
    await expect(page.getByRole('heading', { name: '统一侧栏设计约定' })).toBeVisible();
    await expect(page.locator('[data-memory-id]')).toHaveCount(5);

    // 置顶、编辑、删除
    await page.getByRole('button', { name: '置顶 统一侧栏设计约定' }).click();
    await expect(page.getByRole('button', { name: '取消置顶 统一侧栏设计约定' })).toBeVisible();

    await page.getByRole('button', { name: '编辑 统一侧栏设计约定' }).click();
    const editForm = page.getByTestId('edit-memory-form');
    await editForm.getByLabel('标题').fill('统一侧栏设计约定（已修订）');
    await editForm.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByRole('heading', { name: '统一侧栏设计约定（已修订）' })).toBeVisible();

    await page.getByRole('button', { name: '删除 统一侧栏设计约定（已修订）' }).click();
    await expect(page.getByRole('heading', { name: '统一侧栏设计约定（已修订）' })).toHaveCount(0);

    // 暂停自动睡眠与立即睡眠整合
    await page.getByTestId('auto-sleep-pause-toggle').check();
    await expect(page.getByText('自动睡眠已暂停')).toBeVisible();
    await page.getByTestId('consolidate-now-btn').click();
    await expect(page.getByTestId('sleep-feedback')).toContainText('整合 15 轮对话');

    await expectNoOverflow(page);
    await axeCheck(page);
    expect(errors).toEqual([]);
  });

  test('「技能工坊」Tab v1->v2 差异、SKILL.md 编辑、作用域切换、批准/停用/代谢归档恢复、导出与手动新建验证', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 960 });
    await openUnifiedPanel(page, 'pending-approvals', 'dark', 'skills');

    // 1. v1 -> v2 行级差异对比
    await page.getByRole('button', { name: '查看 v1 → v2 差异 playwright-contrast-guard' }).click();
    const diffView = page.getByTestId('skill-diff-view');
    await expect(diffView).toBeVisible();
    await expect(diffView).toContainText('+ - [v2 新增]');
    await axeCheck(page);

    // 2. 批准启用 v2 修订草案
    await page.getByRole('button', { name: '批准启用 playwright-contrast-guard' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText('已批准启用 playwright-contrast-guard (v2)');
    await expect(page.locator('[data-skill-name="playwright-contrast-guard"]')).toContainText('v2');

    // 3. 在线编辑 SKILL.md、切换工作区作用域、导出至 .agents/skills
    await page.getByRole('button', { name: '编辑 SKILL.md playwright-contrast-guard' }).click();
    await page.getByTestId('edit-skill-form').getByRole('button', { name: '保存并热重载' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText('已保存并热重载技能');

    await page
      .getByLabel('生效作用域切换 playwright-contrast-guard')
      .selectOption({ label: '工作区：~/work/demo-web' });
    await expect(page.getByTestId('growth-feedback')).toContainText('限定至工作区生效');

    await page.getByRole('button', { name: '导出至 .agents/skills playwright-contrast-guard' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText(
      '.agents/skills/playwright-contrast-guard/SKILL.md',
    );
    await expect(page.locator('[data-skill-name="playwright-contrast-guard"]')).toContainText(
      '已导出：~/work/demo-web',
    );

    // 4. 停用/启用与 60 天代谢归档、恢复
    await page.getByRole('button', { name: '停用 playwright-contrast-guard' }).click();
    await expect(page.getByTestId('tab-active')).toContainText('已启用 (1/2)');
    await page.getByRole('button', { name: '启用 playwright-contrast-guard' }).click();
    await expect(page.getByTestId('tab-active')).toContainText('已启用 (2)');

    await expect(page.getByTestId('stale-skill-badge')).toContainText('68天零调用 · 建议归档');
    await page.getByRole('button', { name: '归档 legacy-sqlite-migration' }).click();
    await page.getByTestId('tab-archived').click();
    await expect(page.locator('[data-archived-name="legacy-sqlite-migration"]')).toBeVisible();
    await page.getByRole('button', { name: '恢复启用 legacy-sqlite-migration' }).click();
    await expect(page.locator('[data-skill-name="legacy-sqlite-migration"]')).toBeVisible();

    // 5. 手动新建技能草案与立即提炼技能
    await page.getByTestId('new-skill-btn').click();
    await axeCheck(page);
    const createForm = page.getByTestId('create-skill-form');
    await createForm.getByLabel('技能名称（kebab-case）').fill('unified-e2e-workflow');
    await createForm
      .getByLabel('功能与触发描述（10–1024 字）')
      .fill('Reusable verification workflow created in unified ASI panel E2E.');
    await createForm.getByLabel('指令正文（Markdown）').fill('# Unified Workflow\n\n1. Run `pnpm check`.');
    await createForm.getByRole('button', { name: '生成待审草案' }).click();
    await expect(page.getByRole('heading', { name: 'unified-e2e-workflow' })).toBeVisible();

    await page.getByTestId('synthesize-now-btn').click();
    await expect(page.getByTestId('growth-feedback')).toContainText('提炼 1 份待审 SKILL.md 草案');

    // 在「已启用」子视图下若仍存在待审草案，顶部焦点条依然清晰提示；切到其他 Tab 再点「技能工坊」角标自动落回「待审草案」
    await page.getByTestId('tab-active').click();
    await expect(page.getByTestId('spotlight-draft-banner')).toBeVisible();
    await page.getByTestId('asi-main-tab-care').click();
    await page.getByTestId('asi-main-tab-skills').click();
    await expect(page.getByRole('heading', { name: 'vitest-cordis-lifecycle' })).toBeVisible();

    await expectNoOverflow(page);
    await axeCheck(page);
    expect(errors).toEqual([]);
  });

  test('超大记忆库（totalMemories > memories.length）远端搜索期间执行置顶、编辑、删除实时刷新无陈旧残留', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 920 });
    await page.goto('/?scenario=pending-approvals&theme=light&tab=memory&overflowVault=1');
    await page.getByTestId('asi-unified-panel').waitFor();

    const searchInput = page.getByTestId('memory-search-input');
    await searchInput.fill('overflow-vault-hit');
    await expect(page.getByRole('heading', { name: '溢出一页的深层记忆条目' })).toBeVisible();

    await page.getByRole('button', { name: '置顶 溢出一页的深层记忆条目' }).click();
    await expect(page.getByRole('button', { name: '取消置顶 溢出一页的深层记忆条目' })).toBeVisible();

    await page.getByRole('button', { name: '编辑 溢出一页的深层记忆条目' }).click();
    const editForm = page.getByTestId('edit-memory-form');
    await editForm.getByLabel('标题').fill('溢出一页的深层记忆条目（已编辑）');
    await editForm.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByRole('heading', { name: '溢出一页的深层记忆条目（已编辑）' })).toBeVisible();

    await page.getByRole('button', { name: '删除 溢出一页的深层记忆条目（已编辑）' }).click();
    await expect(page.getByRole('heading', { name: '溢出一页的深层记忆条目（已编辑）' })).toHaveCount(0);
    await expect(page.getByTestId('empty-memories-hint')).toBeVisible();

    await axeCheck(page);
    expect(errors).toEqual([]);
  });

  test('RPC 动作异常时在三大分栏、焦点条与低频环境抽屉权限授权按钮均优雅捕获展示告警横幅，零 pageerror', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 920 });
    await page.goto('/?scenario=pending-approvals&theme=light&tab=care&failActions=1');
    await page.getByTestId('asi-unified-panel').waitFor();

    await page.getByTestId('trigger-check-btn').click();
    await expect(page.getByTestId('care-feedback')).toContainText('立即自检失败');

    // 展开底部环境抽屉点击「授权」按钮，验证异常被捕获进 care-feedback 而绝不抛出未处理 Promise 拒绝
    await page.getByTestId('drawer-env').locator('> summary').click();
    await page.getByTestId('drawer-env').getByRole('button', { name: '授权' }).click();
    await expect(page.getByTestId('care-feedback')).toContainText('打开权限设置失败');

    await page.getByTestId('spotlight-approve-draft').click();
    const spotlightAlert = page.getByTestId('spotlight-feedback');
    await expect(spotlightAlert).toContainText('批准草案失败');
    await expect(spotlightAlert).toHaveAttribute('role', 'alert');

    await page.getByTestId('asi-main-tab-memory').click();
    await page.getByTestId('consolidate-now-btn').click();
    await expect(page.getByTestId('sleep-feedback')).toContainText('立即睡眠整合失败');

    await page.getByTestId('asi-main-tab-skills').click();
    await page.getByTestId('synthesize-now-btn').click();
    await expect(page.getByTestId('growth-feedback')).toContainText('立即提炼失败');

    expect(errors).toEqual([]);
  });

  test('方向 B「搭档状态与协作眼力见」顶部徽标跳转、一键校准锁定、基线抽屉与 320px axe 合规验证', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 320, height: 920 });
    await openUnifiedPanel(page, 'pending-approvals', 'dark', 'memory');

    // 在「记忆库」页点击顶部胶囊的「搭档·攻坚」徽标，一键跳回「稳态看护」页查看眼力见卡片
    const badge = page.getByTestId('tom-capsule-badge');
    await expect(badge).toContainText('搭档·攻坚');
    await badge.click();
    await expect(page.getByTestId('tabpanel-care')).toBeVisible();

    const tomCard = page.getByTestId('tom-partner-card');
    await expect(tomCard).toBeVisible();
    await expect(page.getByTestId('tom-state-pill')).toContainText('排障攻坚');

    // 一键手动校准为「深度心流」，验证处方实时切换并记录校准计数
    await page.getByTestId('tom-override-deep_focus').click();
    await expect(page.getByTestId('tom-state-pill')).toContainText('手动锁定 · 深度心流');
    await expect(page.getByTestId('tom-tact-headline')).toContainText('沉浸心流护航');
    await expect(badge).toContainText('搭档·心流');

    // 展开个体节律基线抽屉并验证重置与开关切换
    const tomDrawer = page.getByTestId('drawer-tom');
    await tomDrawer.locator('> summary').click();
    await expect(tomDrawer).toHaveAttribute('open', '');
    await page.getByTestId('tom-reset-baseline-btn').click();
    await expect(page.getByTestId('tom-feedback')).toContainText('已重置个人交互节律基线');

    await page.getByTestId('tom-enabled-toggle').uncheck();
    await expect(page.getByTestId('tom-state-pill')).toContainText('已关闭');
    await expect(badge).toHaveCount(0);
    await page.getByTestId('tom-enabled-toggle').check();
    await expect(badge).toBeVisible();

    await expectNoOverflow(page);
    await axeCheck(page);
    expect(errors).toEqual([]);
  });
});
