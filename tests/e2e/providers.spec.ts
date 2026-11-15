import { addCompatibleProvider, openSettings, providerRow, TEST_KEY } from './actions';
import { expect, test } from './fixtures';

test('faux provider has a configured key', async ({ launchApp }) => {
  const { page } = await launchApp();
  await openSettings(page);
  const faux = providerRow(page, 'Faux (测试)');
  await expect(faux).toBeVisible();
  await expect(faux.getByTestId('provider-key-status')).toContainText('已设置');
});

test('compatible provider can be tested, disabled and deleted with confirmation', async ({ launchApp }) => {
  test.setTimeout(60_000);
  const { page } = await launchApp();
  await addCompatibleProvider(page);
  const row = providerRow(page);
  const providerId = await row.getAttribute('data-id');
  expect(providerId).toBeTruthy();
  await row.click();
  await expect(page.getByTestId('pe-apikey')).not.toHaveValue(TEST_KEY);

  const modelRow = page.getByTestId('pe-model-row').and(page.locator('[data-model-id="m1"]'));
  await modelRow.getByTestId('pe-model-test').click();
  const result = modelRow.getByTestId('pe-model-test-result');
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toContainText(/失败|错误|failed|error|ECONNREFUSED|✗/i, { timeout: 20_000 });
  await expect(result).not.toContainText(TEST_KEY);
  await page.getByTestId('pe-cancel').click();

  await page.getByTestId('nav-new-chat').click();
  await page.getByTestId('model-picker').last().click();
  const option = page
    .getByTestId('model-option')
    .and(page.locator(`[data-provider-id="${providerId}"][data-model-id="m1"]`));
  await expect(option).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await providerRow(page).getByTestId('provider-toggle').click();
  await page.getByTestId('nav-new-chat').click();
  await page.getByTestId('model-picker').last().click();
  await expect(option).toHaveCount(0);

  await page.getByTestId('nav-settings').click();
  await providerRow(page).click();
  await page.getByTestId('pe-delete').click();
  await expect(page.getByTestId('pe-delete-confirm')).toBeVisible();
  await page.getByTestId('pe-delete-confirm').click();
  await expect(providerRow(page)).toHaveCount(0);
});
