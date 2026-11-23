import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  define: { 'import.meta.env.ASI_PERF_STRICT': JSON.stringify(process.env.ASI_PERF_STRICT ?? '') },
  test: {
    globals: true,
    include: ['test/unit/**/*.test.{ts,tsx}'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [
        {
          browser: 'chromium',
          launch: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : { channel: 'chrome' },
        },
      ],
    },
  },
});
