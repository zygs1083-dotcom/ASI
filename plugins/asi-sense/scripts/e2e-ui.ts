import { expect, type Locator, type Page } from '@playwright/test';

export async function checkResponsive(page: Page, panel: Locator, screenshot: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible()) {
    await collapse.click();
  }
  await expect(page.locator('nav[aria-label="Global panels"]')).toHaveCSS('visibility', 'hidden');
  await expect(panel).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
  for (const metric of ['cpu', 'memory', 'disks', 'tokens']) {
    const card = panel.locator(`[data-tile="${metric}"]`);
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > widths.viewport) throw new Error(`Responsive card clipped: ${metric}`);
  }
  for (const name of ['暂停感知', '窗口标题发给模型']) {
    const control = panel.getByLabel(name);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > widths.viewport)
      throw new Error(`Responsive control clipped: ${name}`);
  }
  const heading = panel.getByRole('heading', { name: '环境感知' });
  await heading.scrollIntoViewIfNeeded();
  expect(
    await heading.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const atStart = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2);
      return atStart === element || element.contains(atStart);
    }),
  ).toBe(true);
  await page.screenshot({ path: screenshot, clip: { x: 0, y: 0, width: 390, height: 600 } });
  await page.setViewportSize({ width: 1440, height: 900 });
}
