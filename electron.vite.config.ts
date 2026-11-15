import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { devCspPlugin } from './src/renderer/dev/csp';

export default defineConfig({
  main: {},
  preload: {
    build: {
      // sandboxed preload cannot load ESM or reach node_modules: bundle everything into one CJS file
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), devCspPlugin()],
  },
});
