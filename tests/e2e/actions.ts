import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

export const PROVIDER_NAME = 'Local compatible';
export const TEST_KEY = 'test-key-not-real';

export async function newFauxChat(page: Page): Promise<void> {
  await expect(page.getByTestId('nav-new-chat')).toBeVisible();
  await page.getByTestId('nav-new-chat').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('model-picker').last().click();
  const model = page.getByTestId('model-option').and(page.locator('[data-model-id="faux-chat"]'));
  await expect(model).toBeVisible();
  await model.click();
}

export async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

export function providerRow(page: Page, name = PROVIDER_NAME): Locator {
  return page.getByTestId('provider-row').filter({ hasText: name });
}

export async function openSettings(page: Page): Promise<void> {
  await expect(page.getByTestId('nav-settings')).toBeVisible();
  await page.getByTestId('nav-settings').click();
}

export async function addCompatibleProvider(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByTestId('provider-add').click();
  await page.getByTestId('pe-kind-compatible').click();
  await page.getByTestId('pe-name').fill(PROVIDER_NAME);
  await page.getByTestId('pe-baseurl').fill('http://127.0.0.1:9/v1');
  await page.getByTestId('pe-model-input').fill('m1');
  await page.getByTestId('pe-model-input').press('Enter');
  await expect(page.getByTestId('pe-model-tag').filter({ hasText: 'm1' })).toBeVisible();
  await page.getByTestId('pe-apikey').fill(TEST_KEY);
  await page.getByTestId('pe-save').click();
  await expect(providerRow(page)).toBeVisible();
}
