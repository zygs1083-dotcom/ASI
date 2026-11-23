import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const SCENARIOS = [
  'healthy',
  'memory-pressure',
  'rapid-change',
  'low-energy',
  'permission-denied',
  'external-cache-arbitration',
] as const;
const THEMES = ['light', 'dark'] as const;

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function open(page: Page, scenario: string, theme: string) {
  await page.goto(`/?scenario=${scenario}&theme=${theme}`);
  await page.getByRole('heading', { name: '生存需求' }).waitFor();
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

test.describe('NeedsPanel 响应式与无障碍验证', () => {
  for (const scenario of SCENARIOS) {
    for (const theme of THEMES) {
      test(`${scenario} 320px ${theme} 无溢出且通过 axe`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width: 320, height: 900 });
        await open(page, scenario, theme);
        for (const name of ['生存需求', '自发维护', '核心体征', '当前环境', '控制与隐私']) {
          await expect(page.locator('details > summary', { hasText: name }).first()).toBeVisible();
        }
        await expectNoOverflow(page);
        await axeCheck(page);
        expect(errors).toEqual([]);
      });
    }
  }
});
