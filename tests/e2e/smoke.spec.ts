import { expect, test } from './fixtures';

const EXPECTED_METHODS = [
  'providers.catalog',
  'providers.list',
  'providers.save',
  'providers.remove',
  'providers.models',
  'providers.allModels',
  'providers.test',
  'conversations.list',
  'conversations.get',
  'conversations.create',
  'conversations.rename',
  'conversations.remove',
  'conversations.setModel',
  'chat.send',
  'chat.abort',
  'chat.onEvent',
  'settings.get',
  'settings.set',
];

test('Electron window boots with the secure API boundary', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await expect.poll(() => page.evaluate('document.readyState')).toBe('complete');

  const apiMethods = await page.evaluate(() => {
    const api = (globalThis as { asi?: Record<string, Record<string, unknown>> }).asi;
    if (!api) return [];
    return Object.entries(api).flatMap(([group, methods]) =>
      Object.entries(methods)
        .filter(([, value]) => typeof value === 'function')
        .map(([name]) => `${group}.${name}`),
    );
  });
  expect(apiMethods.sort()).toEqual([...EXPECTED_METHODS].sort());

  const security = await app.evaluate(async ({ app, BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const metric = app.getAppMetrics().find((m) => m.pid === wc.getOSProcessId());
    const [requireType, processType, separateGlobals] = await Promise.all([
      wc.executeJavaScript('typeof window.require'),
      wc.executeJavaScript('typeof window.process'),
      wc
        .executeJavaScriptInIsolatedWorld(999, [
          { code: 'typeof window !== "undefined" && typeof window.asi === "undefined"' },
        ])
        .catch(() => false),
    ]);
    return { rendererSandboxed: metric?.sandboxed ?? null, requireType, processType, separateGlobals };
  });
  expect(security).toEqual({
    rendererSandboxed: true,
    requireType: 'undefined',
    processType: 'undefined',
    separateGlobals: true,
  });
});

test('fixture can restart Electron with the same isolated data directory', async ({ dataDir, launchApp }) => {
  const first = await launchApp();
  expect(await first.app.evaluate(() => process.env.ASI_DATA_DIR)).toBe(dataDir);
  expect(await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())).toEqual(
    [1100, 720],
  );
  expect(first.page.viewportSize()).toEqual({ width: 1100, height: 720 });
  await first.app.close();

  const second = await launchApp({ dataDir });
  expect(await second.app.evaluate(() => process.env.ASI_DATA_DIR)).toBe(dataDir);
  await expect.poll(() => second.page.evaluate('document.readyState')).toBe('complete');
});
