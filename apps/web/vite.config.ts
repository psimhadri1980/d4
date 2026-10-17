import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @d4/core and @d4/metamodel are CommonJS workspace packages; pre-bundle them for the browser.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  optimizeDeps: { include: ['@d4/core', '@d4/metamodel'] },
  build: {
    commonjsOptions: { include: [/packages\/(core|metamodel)\//, /node_modules/] },
    sourcemap: true,
  },
  test: { environment: 'jsdom' },
});
