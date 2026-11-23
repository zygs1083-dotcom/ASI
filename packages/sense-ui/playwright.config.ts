import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/../screenshots/{arg}{ext}',
  updateSnapshots: 'none',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001, threshold: 0.1 } },
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  // Playwright 的 Chromium 随 lockfile 锁定，避免本机 Chrome 升级导致截图漂移。
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
