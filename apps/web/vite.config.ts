import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The @d4 workspace packages are CommonJS; pre-bundle them for the browser.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  optimizeDeps: { include: ['@d4/core', '@d4/metamodel', '@d4/render', '@d4/ui-kit'] },
  build: {
    commonjsOptions: { include: [/packages\/(core|metamodel|render|ui-kit)\//, /node_modules/] },
    sourcemap: true,
  },
  test: { environment: 'jsdom' },
});
