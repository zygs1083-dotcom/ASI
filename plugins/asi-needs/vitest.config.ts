import { fileURLToPath } from 'node:url';
import { decoratorPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{ ...decoratorPlugin(), enforce: 'pre' }],
  resolve: {
    alias: {
      'asi-sense': fileURLToPath(new URL('../asi-sense/src/host/dsh/index.ts', import.meta.url)),
    },
  },
  test: {
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
    },
  },
});
