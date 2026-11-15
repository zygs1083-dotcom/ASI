import { defineConfig } from 'vitest/config';

// 渲染进程本地回归测试：node 环境 + window.asi/document stub，
// 独立于根 vitest（只跑 tests/unit）之外运行。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/renderer/dev/*.test.ts', 'src/renderer/dev/*.test.tsx'],
  },
});
