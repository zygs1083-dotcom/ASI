import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devCspPlugin } from './src/renderer/dev/csp';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), devCspPlugin()],
});
