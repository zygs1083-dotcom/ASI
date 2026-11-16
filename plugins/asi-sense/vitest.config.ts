import { decoratorPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{ ...decoratorPlugin(), enforce: 'pre' }],
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      thresholds: {
        'src/host/attention/**': { lines: 90 },
      },
    },
  },
});
