import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { shared } from '../web/federation.shared';

const exposed = fileURLToPath(new URL('../web/src/modules/admin/module.tsx', import.meta.url));
const preamble = fileURLToPath(new URL('./dev-preamble.ts', import.meta.url));

/** Dev mode only: the exposed module imports the React Refresh preamble first (dev-preamble.ts). */
function refreshPreamble(): Plugin {
  return {
    name: 'd4-refresh-preamble',
    apply: 'serve',
    enforce: 'pre',
    transform: (code, id) => (id === exposed ? `import ${JSON.stringify(preamble)};\n${code}` : undefined),
  };
}

// The admin module as a remote: the shell loads `admin/module` from /mfe/admin/remoteEntry.js.
// Spike: it exposes the module's existing files in apps/web instead of its own copy.
export default defineConfig({
  base: '/mfe/admin/',
  plugins: [
    refreshPreamble(),
    react(),
    federation({
      name: 'admin',
      filename: 'remoteEntry.js',
      manifest: true,
      dts: false,
      exposes: { './module': '../web/src/modules/admin/module.tsx' },
      shared,
    }),
  ],
  // The shared React is the shell's, usually a production build without `jsxDEV`: compile JSX for
  // the production runtime in dev too.
  esbuild: { jsx: 'automatic', jsxDev: false },
  server: { port: 5175, strictPort: true, origin: 'http://localhost:5175' },
  build: { target: 'es2022', sourcemap: true },
});
