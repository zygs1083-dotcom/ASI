import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { addCompatibleProvider, newFauxChat, providerRow, send, TEST_KEY } from './actions';
import { expect, test } from './fixtures';

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return files.flat();
}

test('renderer has no Node globals and exposes window.asi', async ({ launchApp }) => {
  const { page } = await launchApp();
  const boundary = await page.evaluate(() => {
    const window = globalThis as { require?: unknown; process?: unknown; asi?: unknown };
    return { require: typeof window.require, process: typeof window.process, asi: typeof window.asi };
  });
  expect(boundary).toEqual({ require: 'undefined', process: 'undefined', asi: 'object' });
});

test('saved API keys are not stored in plaintext', async ({ dataDir, launchApp }) => {
  const { app, page } = await launchApp();
  const encryptionAvailable = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  // The contract permits plaintext fallback only in test data directories without safeStorage.
  test.fixme(!encryptionAvailable, 'safeStorage unavailable; the test-only plaintext fallback is permitted');
  await addCompatibleProvider(page);
  await expect(providerRow(page).getByTestId('provider-key-status')).toContainText('已设置');
  await app.close();

  const files = await filesUnder(dataDir);
  expect(files.some((file) => basename(file) === 'keys.json')).toBe(true);
  for (const file of files) {
    expect((await readFile(file)).includes(TEST_KEY), `plaintext key in ${file}`).toBe(false);
  }
});

test('assistant links open externally without navigating or creating an app window', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ fauxReply: '[x](https://example.com)' });
  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { externalUrls: string[] };
    state.externalUrls = [];
    shell.openExternal = async (url: string) => {
      state.externalUrls.push(url);
    };
  });
  await newFauxChat(page);
  await send(page, 'link');
  const assistant = page.getByTestId('msg-assistant');
  await expect(assistant).toHaveAttribute('data-status', 'done');
  const originalUrl = page.url();
  await assistant.getByRole('link', { name: 'x' }).click();

  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as typeof globalThis & { externalUrls: string[] }).externalUrls),
    )
    .toEqual(['https://example.com/']);
  expect(page.url()).toBe(originalUrl);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(app.windows()).toHaveLength(1);
});
