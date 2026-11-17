import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Locator, type Page, test } from '@playwright/test';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function checkA11y(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string }[] }> } })
      .axe;
    return (await axe.run()).violations;
  });
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'region')).toEqual([]);
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  const outline = await target.evaluate((el) => ({
    style: getComputedStyle(el).outlineStyle,
    width: parseFloat(getComputedStyle(el).outlineWidth),
  }));
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
}

async function expectInViewport(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

for (const theme of ['light', 'dark']) {
  test(`收起后失败及超时提示保持可见，关闭后恢复焦点 ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.clock.install();
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto('/test/e2e/tuning-alert.html');
    if (theme === 'dark') await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    const summary = page.locator('details > summary', { hasText: '规则' }).first();
    await summary.click();
    await page.getByRole('button', { name: '恢复 AI 调参' }).click();
    await summary.click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-reject')));
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('恢复 AI 调参失败，请重试');
    await expectInViewport(page, alert);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectInViewport(page, alert);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expectInViewport(page, alert);
    expect(await alert.evaluate((el) => el.closest('details'))).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await checkA11y(page);
    await expect(alert).toHaveScreenshot(`tuning-failure-alert-320-${theme}.png`);
    const close = alert.getByRole('button', { name: '关闭操作提示' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(summary).toBeFocused();
    await expect(alert).toHaveCount(0);

    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '恢复 AI 调参' }).click();
    await summary.click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-resolve')));
    await page.clock.fastForward(10_000);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('恢复 AI 调参：未确认结果，请检查状态');
    await expectInViewport(page, alert);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectInViewport(page, alert);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expectInViewport(page, alert);
    await expect(alert.getByRole('button', { name: '关闭操作提示' })).toBeVisible();
    await checkA11y(page);
    expect(errors).toEqual([]);
  });

  test(`提示出现后危险操作不被遮挡 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto('/test/e2e/tuning-alert.html');
    if (theme === 'dark') await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    await page.locator('details > summary', { hasText: '规则' }).first().click();
    const resume = page.getByRole('button', { name: '恢复 AI 调参' });
    await resume.click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-reject')));
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('失败');
    await page.getByRole('button', { name: '调整日志' }).click();
    for (const button of [resume, page.getByRole('button', { name: '确认重新基线' }).first()]) {
      for (const block of ['start', 'end'] as const) {
        await button.evaluate((target, position) => target.scrollIntoView({ block: position }), block);
        await expectInViewport(page, alert);
        const covered = await button.evaluate((target) => {
          const rect = target.getBoundingClientRect();
          return !target.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        expect(covered).toBe(false);
      }
    }
    await resume.click();
    await expect(resume).toBeDisabled();
  });

  test(`嵌入滚动容器中失败和超时提示保持在面板内 ${theme}`, async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto('/test/e2e/tuning-alert.html');
    if (theme === 'dark') await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    const stage = page.locator('.stage');
    await stage.evaluate((el) => Object.assign(el.style, { height: '320px', overflowY: 'auto', marginTop: '60px' }));
    const summary = page.locator('details > summary', { hasText: '规则' }).first();
    const resume = page.getByRole('button', { name: '恢复 AI 调参' });
    const alert = page.getByRole('alert');
    await summary.click();
    await resume.click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-reject')));
    await expect(alert).toContainText('失败');
    await page.getByRole('button', { name: '调整日志' }).click();
    const suggestion = page.getByRole('button', { name: '确认重新基线' }).first();
    for (const block of ['start', 'end'] as const) {
      await suggestion.evaluate((el, position) => el.scrollIntoView({ block: position }), block);
      expect(
        await suggestion.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }),
      ).toBe(true);
    }
    for (const scroll of ['top', 'bottom'] as const) {
      await stage.evaluate((el, position) => {
        el.scrollTop = position === 'top' ? 0 : el.scrollHeight;
      }, scroll);
      const container = (await stage.boundingBox())!;
      const box = (await alert.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(container.y);
      expect(box.y + box.height).toBeLessThanOrEqual(container.y + container.height);
    }
    await resume.click();
    await summary.click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-resolve')));
    await page.clock.fastForward(10_000);
    await expect(alert).toContainText('未确认结果');
    for (const scroll of ['top', 'bottom'] as const) {
      await stage.evaluate((el, position) => {
        el.scrollTop = position === 'top' ? 0 : el.scrollHeight;
      }, scroll);
      const container = (await stage.boundingBox())!;
      const box = (await alert.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(container.y);
      expect(box.y + box.height).toBeLessThanOrEqual(container.y + container.height);
    }
  });

  for (const first of [0, 1]) {
    test(`并发提示依次键盘关闭并聚焦相邻提示 ${theme} ${first}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 480 });
      await page.goto('/test/e2e/tuning-alert.html');
      if (theme === 'dark') await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
      const summary = page.locator('details > summary', { hasText: '规则' }).first();
      await summary.click();
      await page.getByRole('button', { name: '恢复 AI 调参' }).click();
      await page.getByRole('button', { name: '调整日志' }).click();
      await page.getByRole('button', { name: '确认重新基线' }).first().click();
      await page.getByRole('button', { name: '确认应用' }).click();
      await page.evaluate(() => {
        window.dispatchEvent(new Event('test-reject'));
        window.dispatchEvent(new Event('test-reject-suggestion'));
      });
      const alerts = page.getByRole('alert');
      await expect(alerts).toHaveCount(2);
      for (const alert of await alerts.all()) await expectInViewport(page, alert);
      const close = alerts.nth(first).getByRole('button', { name: '关闭操作提示' });
      await close.focus();
      await page.keyboard.press('Enter');
      const remaining = page.getByRole('alert').getByRole('button', { name: '关闭操作提示' });
      await expect(remaining).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(summary).toBeFocused();
      await expect(alerts).toHaveCount(0);
    });
  }

  test(`tuning-disabled 420 ${theme}: 键盘确认重置`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(`/?scenario=tuning-disabled&theme=${theme}`);
    const summary = page.locator('details > summary', { hasText: '规则' }).first();
    await summary.focus();
    await page.keyboard.press('Enter');
    const trigger = page.getByRole('button', { name: '重置调参' });
    await tabTo(page, trigger);
    await page.keyboard.press('Enter');
    await expect(page.getByText('保存的调参数据损坏，AI 调参已停用')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
    await expect(page.getByRole('alertdialog', { name: '重置调参' })).toHaveAccessibleDescription(
      '将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习',
    );
    await expect(page.getByRole('button', { name: '取消' })).toHaveAccessibleDescription(
      '将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习',
    );
    await expect(page.getByRole('button', { name: '确认重置' })).toHaveAccessibleDescription(
      '将丢弃已保存的调参、锁定和调整记录，所有参数恢复默认值，基线重新学习',
    );
    await expect(page.locator('.demoAction')).toBeEmpty();
    await checkA11y(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`tuning-disabled-420-${theme}.png`, { fullPage: true });
    await page.keyboard.press('Enter');
    await expect(trigger).toBeFocused();
    await expect(page.locator('.demoAction')).toBeEmpty();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.demoAction')).toHaveText('重置调参');
    await expect(trigger).toHaveCount(0);
    await expect(page.getByRole('button', { name: '规则列表' })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test(`rebaseline-suggested 420 ${theme}: 键盘确认基线与恢复`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(`/?scenario=rebaseline-suggested&theme=${theme}`);
    const summary = page.locator('details > summary', { hasText: '规则' }).first();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('保存调参数据失败，AI 调参已停用')).toBeVisible();
    await page.getByRole('button', { name: '调整日志' }).click();
    const list = page.getByRole('list', { name: '重新基线建议' });
    await expect(list).toContainText('CPU · 周二 14 时');
    await expect(list).toContainText('均值 20% → 68%');
    await expect(list).toContainText('12 个样本 · 3 个日期');
    await expect(list).toContainText('391 KB/s → 1.3 MB/s');
    await expect(list).toContainText('磁盘 /demo 剩余 · 周三 9 时');
    await expect(list).toContainText('均值 80.0 GB → 60.0 GB');
    await expect(list).toContainText('Token 上下文剩余 · 周四 11 时');
    await expect(list).toContainText('均值 50.0k → 30.0k');
    const trigger = list.getByRole('button', { name: '确认重新基线' }).first();
    await page.getByRole('button', { name: '调整日志' }).focus();
    await tabTo(page, trigger);
    await page.keyboard.press('Enter');
    await expect(page.getByText('持续故障和新负载无法自动区分，请确认这是正常的新状态')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
    await expect(page.getByRole('alertdialog', { name: '确认重新基线' })).toHaveAccessibleDescription(
      /持续故障和新负载无法自动区分/,
    );
    await expect(page.getByRole('button', { name: '取消' })).toHaveAccessibleDescription(
      /CPU · 周二 14 时.*持续故障和新负载无法自动区分/,
    );
    await expect(page.getByRole('button', { name: '确认应用' })).toHaveAccessibleDescription(
      /CPU · 周二 14 时.*均值 20% → 68%.*持续故障和新负载无法自动区分/,
    );
    await expect(page.locator('.demoAction')).toBeEmpty();
    await checkA11y(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`rebaseline-suggested-420-${theme}.png`, { fullPage: true });
    await page.keyboard.press('Enter');
    await expect(trigger).toBeFocused();
    await expect(page.locator('.demoAction')).toBeEmpty();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.demoAction')).toHaveText('确认重新基线 baseline-cpu');
    await expect(list).not.toContainText('CPU · 周二 14 时');
    await expect(page.getByRole('button', { name: '调整日志' })).toBeFocused();
    await page.getByRole('button', { name: '恢复 AI 调参' }).click();
    await expect(page.locator('.demoAction')).toHaveText('恢复 AI 调参');
    await expect(page.getByText('保存调参数据失败，AI 调参已停用')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '调整日志' })).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const action of [
  { scenario: 'tuning-disabled', label: '重置调参' },
  { scenario: 'rebaseline-suggested', label: '确认重新基线' },
]) {
  test(`${action.label}: 连按 Enter、重复 keydown 和双击入口均不执行`, async ({ page }) => {
    await page.goto(`/?scenario=${action.scenario}`);
    await page.locator('details > summary', { hasText: '规则' }).first().click();
    if (action.scenario === 'rebaseline-suggested') {
      await page.getByRole('button', { name: '调整日志' }).click();
    }
    const trigger = page.getByRole('button', { name: action.label }).first();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.demoAction')).toBeEmpty();

    await trigger.focus();
    await page.keyboard.down('Enter');
    for (let i = 0; i < 5; i++) await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(page.locator('.demoAction')).toBeEmpty();
    const cancel = page.getByRole('button', { name: '取消' });
    if (await cancel.isVisible()) await cancel.click();

    await trigger.dblclick();
    await expect(page.locator('.demoAction')).toBeEmpty();
    await expect(cancel).toBeVisible();
  });
}
