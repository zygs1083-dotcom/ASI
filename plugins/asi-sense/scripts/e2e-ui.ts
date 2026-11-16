import { expect, type Locator, type Page } from '@playwright/test';

const panelOnly =
  'body * { visibility: hidden !important } [data-testid="asi-sense-panel"], [data-testid="asi-sense-panel"] * { visibility: visible !important }';

export async function screenshotDesktop(page: Page, panel: Locator, screenshot: string): Promise<void> {
  await panel.getByRole('heading', { name: '环境感知' }).scrollIntoViewIfNeeded();
  const box = await panel.boundingBox();
  const boxes = await Promise.all(
    ['cpu', 'memory', 'disks', 'tokens'].map((metric) => panel.locator(`[data-tile="${metric}"]`).boundingBox()),
  );
  if (!box || boxes.some((item) => item === null)) throw new Error('Metric card geometry is unavailable');
  const bottom = Math.ceil(Math.max(...boxes.map((item) => (item ? item.y + item.height : 0))) + 8);
  if (bottom > 900) throw new Error('Metric cards do not fit in the screenshot viewport');
  const x = Math.max(0, Math.ceil(box.x));
  const y = Math.max(0, Math.ceil(box.y));
  const right = Math.min(1440, Math.floor(box.x + box.width));
  const end = Math.min(bottom, Math.floor(box.y + box.height));
  if (right <= x || end <= y) throw new Error('Panel is outside the screenshot viewport');
  await page.screenshot({
    path: screenshot,
    style: panelOnly,
    clip: { x, y, width: right - x, height: end - y },
  });
}

export async function checkResponsive(page: Page, panel: Locator, screenshot?: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  const nav = page.locator('nav[aria-label="Global panels"]');
  if (await collapse.isVisible()) {
    try {
      await collapse.click({ timeout: 2000 });
    } catch (error) {
      if ((await nav.evaluate((element) => getComputedStyle(element).visibility)) !== 'hidden') throw error;
    }
  }
  await expect(nav).toHaveCSS('visibility', 'hidden');
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
  if (screenshot) {
    const box = await panel.boundingBox();
    if (!box) throw new Error('Panel geometry is unavailable');
    const x = Math.max(0, Math.ceil(box.x));
    const y = Math.max(0, Math.ceil(box.y));
    const right = Math.min(390, Math.floor(box.x + box.width));
    const end = Math.min(y + 600, 844, Math.floor(box.y + box.height));
    if (right <= x || end <= y) throw new Error('Panel is outside the screenshot viewport');
    await page.screenshot({
      path: screenshot,
      style: panelOnly,
      clip: { x, y, width: right - x, height: end - y },
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
