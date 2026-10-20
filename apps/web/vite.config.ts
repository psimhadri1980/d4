import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';

// The icon package's entry also re-exports thousands of lazy `import()`s, which the dev server
// turns into one chunk each. Its plain icon index has the same named exports without them.
const tablerIcons = join(dirname(createRequire(import.meta.url).resolve('@tabler/icons-react/package.json')), 'dist/esm/icons/index.mjs');

// The @d4 workspace packages are CommonJS; pre-bundle them for the browser.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@tabler\/icons-react$/, replacement: tablerIcons }] },
  server: { port: 5173, strictPort: true },
  optimizeDeps: { include: ['@d4/core', '@d4/metamodel', '@d4/render', '@d4/ui-kit'] },
  build: {
    commonjsOptions: { include: [/packages\/(core|metamodel|render|ui-kit)\//, /node_modules/] },
    sourcemap: true,
  },
  test: { environment: 'jsdom' },
});
