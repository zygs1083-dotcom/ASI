import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, type ElectronApplication, _electron as electron, type Page } from '@playwright/test';

export const FAUX_REPLY = `Deterministic faux reply. ${'The response arrives incrementally before it finishes. '.repeat(5)}Finished.`;

type LaunchOptions = { dataDir?: string; fauxReply?: string };
type LaunchedApp = { app: ElectronApplication; page: Page };

type Fixtures = {
  dataDir: string;
  launchApp: (options?: LaunchOptions) => Promise<LaunchedApp>;
};

export const test = base.extend<Fixtures>({
  dataDir: async ({ browserName: _browserName }, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-e2e-'));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  launchApp: async ({ dataDir }, use) => {
    const apps = new Set<ElectronApplication>();
    try {
      await use(async (options = {}) => {
        const env: Record<string, string> = {
          ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
          ASI_DATA_DIR: options.dataDir ?? dataDir,
          ASI_FAUX: '1',
          ASI_FAUX_REPLY: options.fauxReply ?? FAUX_REPLY,
        };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.ELECTRON_RENDERER_URL;

        const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
        apps.add(app);
        app.on('close', () => apps.delete(app));
        const page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
        await page.setViewportSize({ width: 1100, height: 720 });
        return { app, page };
      });
    } finally {
      await Promise.all([...apps].map((app) => app.close()));
    }
  },
});

export { expect } from '@playwright/test';
