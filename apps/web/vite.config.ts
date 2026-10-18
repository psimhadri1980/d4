import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @d4/core, @d4/metamodel and @d4/render are CommonJS workspace packages; pre-bundle them for the browser.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  optimizeDeps: { include: ['@d4/core', '@d4/metamodel', '@d4/render'] },
  build: {
    commonjsOptions: { include: [/packages\/(core|metamodel|render)\//, /node_modules/] },
    sourcemap: true,
  },
  test: { environment: 'jsdom' },
});
