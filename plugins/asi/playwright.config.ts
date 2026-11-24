import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

const PORT = 4176;
const useChromeChannelFallback =
  !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && !existsSync(chromium.executablePath());

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
          : useChromeChannelFallback
            ? { channel: 'chrome' }
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
