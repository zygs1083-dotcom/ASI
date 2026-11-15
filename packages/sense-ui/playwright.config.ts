import { defineConfig } from '@playwright/test'

const PORT = 4173

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
