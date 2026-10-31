import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { shared } from './federation.shared';

// The icon package's entry also re-exports thousands of lazy `import()`s, which the dev server
// turns into one chunk each. Its plain icon index has the same named exports without them.
const tablerIcons = join(dirname(createRequire(import.meta.url).resolve('@tabler/icons-react/package.json')), 'dist/esm/icons/index.mjs');

/** `D4_WEB_REMOTES`: `name=entry,…`, e.g. `admin=/mfe/admin/remoteEntry.js` (P6 spike). */
const remotes = () =>
  (process.env.D4_WEB_REMOTES ?? '')
    .split(',')
    .filter(Boolean)
    .map((r) => ({ name: r.split('=')[0]!, entry: r.split('=')[1]! }));

/** Serves /config.json from the environment in development, as deploy/web/config.sh does in the container. */
function runtimeConfig(): Plugin {
  const env = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set; start the dev server with deploy/dev.sh web`);
    return v;
  };
  return {
    name: 'd4-runtime-config',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        const body = JSON.stringify({ apiUrl: env('D4_PUBLIC_API_URL'), oidcAuthority: env('OIDC_ISSUER'), oidcClientId: env('OIDC_CLIENT_ID'), remotes: remotes() });
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      });
    },
  };
}

export default defineConfig({
  // P6 spike: the shell is a federation host; remotes are registered at run time from /config.json.
  plugins: [react(), runtimeConfig(), federation({ name: 'shell', remotes: {}, shared })],
  resolve: { alias: [{ find: /^@tabler\/icons-react$/, replacement: tablerIcons }] },
  // deploy/dev.sh web: behind the gateway, so the HMR socket goes to the gateway's port.
  server: { port: 5174, strictPort: true, hmr: { clientPort: Number(process.env.GATEWAY_PORT) || undefined } },
  // The @d4 packages the browser uses ship ESM under the `browser` export condition.
  build: { sourcemap: true, target: 'es2022' },
  test: { environment: 'jsdom' },
});
