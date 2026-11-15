import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { addCompatibleProvider, providerRow, TEST_KEY } from './actions';
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
