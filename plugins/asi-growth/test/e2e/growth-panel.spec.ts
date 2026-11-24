import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const SCENARIOS = ['workshop-ready', 'deep-quiet-waiting', 'suppressed-lower-tier', 'empty-workshop'] as const;
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
  await page.getByRole('heading', { name: '技能工坊' }).waitFor();
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

test.describe('GrowthPanel「技能工坊」320px 响应式布局与 axe 无障碍验证', () => {
  for (const scenario of SCENARIOS) {
    for (const theme of THEMES) {
      test(`${scenario} 320px ${theme} 零溢出且通过 axe 无障碍扫描`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width: 320, height: 920 });
        await openPanel(page, scenario, theme);
        for (const summaryText of ['技能自进化与静默门控', '技能工坊管理', '安全、代谢与隐私护栏']) {
          await expect(page.locator('details > summary', { hasText: summaryText }).first()).toBeVisible();
        }
        await expectNoOverflow(page);
        await axeCheck(page);
        expect(errors).toEqual([]);
      });
    }
  }

  test('支持 v1->v2 差异检查、SKILL.md 预览编辑、作用域切换、批准/停用/60天代谢归档/恢复、工作区导出与手动新建', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 960 });
    await openPanel(page, 'deep-quiet-waiting', 'dark');

    // 1. 待审草案页：查看 v1 -> v2 行级差异对比并仍然通过 axe 扫描
    await page.getByRole('button', { name: '查看 v1 → v2 差异 playwright-contrast-guard' }).click();
    const diffView = page.getByTestId('skill-diff-view');
    await expect(diffView).toBeVisible();
    await expect(diffView).toContainText('+ - [v2 新增]');
    await axeCheck(page);

    // 2. 批准启用 v2 修订草案 -> 自动跳转至「已启用」视图且版本升至 v2
    await page.getByRole('button', { name: '批准启用 playwright-contrast-guard' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText('已批准启用 playwright-contrast-guard (v2)');
    await expect(page.locator('[data-skill-name="playwright-contrast-guard"]')).toContainText('v2');

    // 3. 在线编辑 SKILL.md、切换工作区作用域、一键导出至 .agents/skills
    await page.getByRole('button', { name: '编辑 SKILL.md playwright-contrast-guard' }).click();
    const editForm = page.getByTestId('edit-skill-form');
    await expect(editForm).toBeVisible();
    await editForm.getByRole('button', { name: '保存并热重载' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText('已保存并热重载技能');

    await page
      .getByLabel('生效作用域切换 playwright-contrast-guard')
      .selectOption({ label: '工作区：~/work/demo-web' });
    await expect(page.getByTestId('growth-feedback')).toContainText('限定至工作区生效');

    await page.getByRole('button', { name: '导出至 .agents/skills playwright-contrast-guard' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText(
      '.agents/skills/playwright-contrast-guard/SKILL.md',
    );

    // 4. 停用再重新启用
    await page.getByRole('button', { name: '停用 playwright-contrast-guard' }).click();
    await expect(page.locator('[data-skill-name="playwright-contrast-guard"]')).toContainText('已停用');
    await page.getByRole('button', { name: '启用 playwright-contrast-guard' }).click();
    await expect(page.locator('[data-skill-name="playwright-contrast-guard"]')).toContainText('已启用 · 热挂载');

    // 5. 识别 60+ 天零调用陈旧技能并一键归档，随后在「已归档」页恢复启用
    await expect(page.getByTestId('stale-skill-badge')).toContainText('68天零调用 · 建议归档');
    await page.getByRole('button', { name: '归档 legacy-sqlite-migration' }).click();
    await page.getByTestId('tab-archived').click();
    await expect(page.locator('[data-archived-name="legacy-sqlite-migration"]')).toBeVisible();
    await page.getByRole('button', { name: '恢复启用 legacy-sqlite-migration' }).click();
    await expect(page.locator('[data-skill-name="legacy-sqlite-migration"]')).toBeVisible();

    // 6. 手动新建技能草案（表单展开态通过 axe）与暂停/立即提炼技能
    await page.getByTestId('new-skill-btn').click();
    await axeCheck(page);
    const createForm = page.getByTestId('create-skill-form');
    await createForm.getByLabel('技能名称（kebab-case）').fill('e2e-custom-workflow');
    await createForm
      .getByLabel('功能与触发描述（10–1024 字）')
      .fill('Reusable verification workflow created in Playwright E2E suite.');
    await createForm.getByLabel('指令正文（Markdown）').fill('# Custom Workflow\n\n1. Run check before commit.');
    await createForm.getByRole('button', { name: '生成待审草案' }).click();
    await expect(page.getByRole('heading', { name: 'e2e-custom-workflow' })).toBeVisible();

    await page.getByTestId('auto-growth-pause-toggle').check();
    await expect(page.getByText('自动提炼已暂停')).toBeVisible();

    await page.getByTestId('synthesize-now-btn').click();
    await expect(page.getByTestId('growth-feedback')).toContainText('提炼 1 份待审 SKILL.md 草案');

    await expectNoOverflow(page);
    await axeCheck(page);
    expect(errors).toEqual([]);
  });

  test('RPC 动作异常时捕获拒绝并展示反馈横幅，零未捕获 Promise 异常 (pageerror)', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 340, height: 900 });
    await page.goto('/?scenario=workshop-ready&theme=light&failActions=1');
    await page.getByRole('heading', { name: '技能工坊' }).waitFor();

    await page.getByTestId('auto-growth-pause-toggle').click();
    await expect(page.getByTestId('growth-feedback')).toContainText('暂停开关失败');

    await page.getByTestId('synthesize-now-btn').click();
    await expect(page.getByTestId('growth-feedback')).toContainText('立即提炼失败');

    await page.getByRole('button', { name: '批准启用 playwright-contrast-guard' }).click();
    await expect(page.getByTestId('growth-feedback')).toContainText('批准草案失败');

    expect(errors).toEqual([]);
  });
});
