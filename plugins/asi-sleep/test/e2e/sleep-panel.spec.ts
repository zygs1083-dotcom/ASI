import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const SCENARIOS = ['healthy-vault', 'sleepy-waiting', 'suppressed-l1', 'empty-vault'] as const;
const THEMES = ['light', 'dark'] as const;

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function openPanel(page: Page, scenario: string, theme: string) {
  await page.goto(`/?scenario=${scenario}&theme=${theme}`);
  await page.getByRole('heading', { name: '记忆库' }).waitFor();
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function axeCheck(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (o?: unknown) => Promise<{ violations: { impact: string; id: string }[] }> } }
    ).axe;
    return axe.run({ resultTypes: ['violations'] });
  });
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'region');
  expect(bad, JSON.stringify(bad.map((v) => v.id))).toEqual([]);
}

test.describe('SleepPanel「记忆库」响应式布局与 axe 无障碍验证', () => {
  for (const scenario of SCENARIOS) {
    for (const theme of THEMES) {
      test(`${scenario} 320px ${theme} 零溢出且通过 axe 无障碍扫描`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width: 320, height: 900 });
        await openPanel(page, scenario, theme);
        for (const summaryText of ['睡眠稳态与整合', '记忆检索与管理', '隐私与架构护栏']) {
          await expect(page.locator('details > summary', { hasText: summaryText }).first()).toBeVisible();
        }
        await expectNoOverflow(page);
        await axeCheck(page);
        expect(errors).toEqual([]);
      });
    }
  }

  test('支持记忆检索、类型筛选、FSRS 保留率与置顶展示、完整 CRUD、暂停开关与立即睡眠整合交互', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 920 });
    await openPanel(page, 'sleepy-waiting', 'dark');

    // 1. 展示已置顶 100% 锁定与 FSRS 保留率
    await expect(page.getByText('已置顶 · 永不衰减').first()).toBeVisible();
    await expect(page.getByText(/FSRS 保留 \d+%/).first()).toBeVisible();

    // 2. 类型筛选：切到「踩坑」仅显示 1 条踩坑记忆，再切回「全部」
    await page.getByRole('button', { name: /^踩坑/ }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await expect(page.getByText('侧栏小字禁用裸绿/裸橙状态色以通过 axe 4.5:1 对比度')).toBeVisible();
    await page.getByRole('button', { name: /^全部/ }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(4);

    // 3. 图形化搜索（支持中文词组、无关助词零误报与英文关键词）
    const searchInput = page.getByTestId('memory-search-input');
    await searchInput.fill('关于数据库的迁移决策');
    await expect(page.getByTestId('empty-memories-hint')).toBeVisible();
    await searchInput.fill('对比度');
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await searchInput.fill('esbuild');
    await expect(page.locator('[data-memory-id]')).toHaveCount(1);
    await page.getByRole('button', { name: '清空搜索词' }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(4);

    // 4. 新建记忆（且表单打开态仍通过 axe 无障碍扫描）
    await page.getByTestId('new-memory-btn').click();
    await axeCheck(page);
    const createForm = page.getByTestId('create-memory-form');
    await createForm.getByLabel('标题').fill('E2E 新增偏好：统一开启严格类型检查');
    await createForm.getByLabel('详细内容').fill('构建前必须执行 tsc 严格模式验证。');
    await createForm.getByLabel('标签（逗号分隔）').fill('typescript, strict');
    await createForm.getByRole('button', { name: '保存记忆' }).click();
    await expect(page.getByRole('heading', { name: 'E2E 新增偏好：统一开启严格类型检查' })).toBeVisible();
    await expect(page.locator('[data-memory-id]')).toHaveCount(5);

    // 5. 置顶、编辑与删除该新增记忆
    await page.getByRole('button', { name: '置顶 E2E 新增偏好：统一开启严格类型检查' }).click();
    await expect(page.getByRole('button', { name: '取消置顶 E2E 新增偏好：统一开启严格类型检查' })).toBeVisible();

    await page.getByRole('button', { name: '编辑 E2E 新增偏好：统一开启严格类型检查' }).click();
    const editForm = page.getByTestId('edit-memory-form');
    await editForm.getByLabel('标题').fill('E2E 已编辑偏好：严格类型检查与门禁');
    await editForm.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByRole('heading', { name: 'E2E 已编辑偏好：严格类型检查与门禁' })).toBeVisible();

    await page.getByRole('button', { name: '删除 E2E 已编辑偏好：严格类型检查与门禁' }).click();
    await expect(page.getByRole('heading', { name: 'E2E 已编辑偏好：严格类型检查与门禁' })).toHaveCount(0);

    // 6. 自动睡眠暂停开关与「立即睡眠整合」动作
    const pauseToggle = page.getByTestId('auto-sleep-pause-toggle');
    await pauseToggle.check();
    await expect(page.getByText('自动睡眠已暂停')).toBeVisible();

    await page.getByTestId('consolidate-now-btn').click();
    await expect(page.getByTestId('sleep-feedback')).toContainText('整合 15 轮对话');
    await expect(page.getByText('满足 100% · 紧迫 0%')).toBeVisible();

    await expectNoOverflow(page);
    await axeCheck(page);
    expect(errors).toEqual([]);
  });

  test('RPC 动作异常时捕获拒绝并展示反馈横幅，零未捕获 Promise 异常 (pageerror)', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 900 });
    await page.goto('/?scenario=healthy-vault&theme=light&failActions=1');
    await page.getByRole('heading', { name: '记忆库' }).waitFor();

    await page.getByTestId('auto-sleep-pause-toggle').click();
    await expect(page.getByTestId('sleep-feedback')).toContainText('暂停开关失败');

    await page
      .getByRole('button', { name: /^取消置顶/ })
      .first()
      .click();
    await expect(page.getByTestId('sleep-feedback')).toContainText('置顶切换失败');

    await page.getByRole('button', { name: /^删除/ }).first().click();
    await expect(page.getByTestId('sleep-feedback')).toContainText('删除记忆失败');

    expect(errors).toEqual([]);
  });
});
