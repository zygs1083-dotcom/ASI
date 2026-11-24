import { decoratorPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{ ...decoratorPlugin(), enforce: 'pre' }],
  test: {
    maxWorkers: 1,
    testTimeout: 30_000,
    include: ['test/**/*.test.{ts,mjs}'],
    exclude: ['test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    },
  },
});
