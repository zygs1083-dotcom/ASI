import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newFauxChat, openSettings, providerRow, send } from './actions';
import { expect, test } from './fixtures';

const scenarios = ['chat-empty', 'chat-streaming', 'chat-done', 'providers-list', 'provider-edit'] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const scenario of scenarios) {
    test(`capture ${scenario} in ${theme} mode`, async ({ launchApp }) => {
      const { page } = await launchApp(
        scenario === 'chat-streaming' ? { fauxReply: `Streaming ${'a visual reply. '.repeat(150)}` } : {},
      );
      await openSettings(page);
      await page.getByTestId(`theme-${theme}`).click();
      await expect
        .poll(() => page.evaluate('document.documentElement.getAttribute("data-theme")'))
        .toBe(theme);

      if (scenario.startsWith('chat-')) {
        await newFauxChat(page);
        await expect(page.getByTestId('chat-empty')).toBeVisible();
        if (scenario !== 'chat-empty') {
          await send(page, '你好');
          await expect(page.getByTestId('msg-user')).toHaveText('你好');
          const assistant = page.getByTestId('msg-assistant');
          await expect(assistant).toHaveAttribute(
            'data-status',
            scenario === 'chat-done' ? 'done' : 'streaming',
          );
          if (scenario === 'chat-streaming') await expect(assistant).toContainText('Streaming');
        }
      } else {
        const faux = providerRow(page, 'Faux (测试)');
        await expect(faux).toBeVisible();
        if (scenario === 'provider-edit') {
          await faux.click();
          await expect(page.getByTestId('pe-save')).toBeVisible();
        }
      }

      await mkdir(resolve('artifacts/screens'), { recursive: true });
      await page.screenshot({
        path: resolve('artifacts/screens', `${scenario}-${theme}.png`),
        animations: 'disabled',
      });
    });
  }
}
