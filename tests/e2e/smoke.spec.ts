import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';

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

test('scaffold window boots with secure api boundary', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'asi-e2e-'));
  const env: Record<string, string> = { ...process.env, ASI_DATA_DIR: dataDir, ASI_FAUX: '1' } as Record<
    string,
    string
  >;
  delete env.ELECTRON_RUN_AS_NODE;

  let app: ElectronApplication | undefined;
  const errors: string[] = [];

  try {
    app = await electron.launch({
      args: [resolve('out/main/index.js')],
      env,
    });
    app.on('window', (page) => {
      page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
      });
    });

    const page = await app.firstWindow();

    await expect(page.getByTestId('app-root')).toBeVisible();
    await expect(page.getByText('ASI 骨架就绪')).toBeVisible();

    const apiMethods = await page.evaluate(() => {
      const api = (globalThis as { asi?: Record<string, Record<string, unknown>> }).asi;
      if (!api) return [];
      return Object.entries(api).flatMap(([group, methods]) =>
        Object.entries(methods)
          .filter(([, v]) => typeof v === 'function')
          .map(([name]) => `${group}.${name}`),
      );
    });
    expect(apiMethods.sort()).toEqual([...EXPECTED_METHODS].sort());

    // Electron 45 removed WebContents.getLastWebPreferences; verify the security
    // settings from runtime evidence in the main process instead.
    const security = await app.evaluate(async ({ app, BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const metric = app.getAppMetrics().find((m) => m.pid === wc.getOSProcessId());
      const [requireType, processType, separateGlobals] = await Promise.all([
        wc.executeJavaScript('typeof window.require'),
        wc.executeJavaScript('typeof window.process'),
        // The bridged API exists in the main world but must not leak into a separate world.
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

    // a real invocation must travel preload -> ipcMain.handle and reject as not implemented
    const ipcReachable = await page.evaluate(() => {
      const api = (globalThis as { asi?: { providers: { catalog(): Promise<unknown> } } }).asi;
      if (!api) return Promise.resolve(false);
      return api.providers.catalog().then(
        () => false,
        (e: unknown) => e instanceof Error && e.message.includes('not implemented'),
      );
    });
    expect(ipcReachable).toBe(true);

    expect(errors).toEqual([]);

    await mkdir(resolve('artifacts/screens'), { recursive: true });
    await page.screenshot({ path: 'artifacts/screens/scaffold.png' });
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
