import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { COMMONJS, SHARED, sharedMajors } from '@d4/web-platform/shared';

// The icon package's entry also re-exports thousands of lazy `import()`s, which the dev server
// turns into one chunk each. Its plain icon index has the same named exports without them.
const tablerIcons = join(dirname(createRequire(import.meta.url).resolve('@tabler/icons-react/package.json')), 'dist/esm/icons/index.mjs');

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
        const body = JSON.stringify({ apiUrl: new URL(env('D4_PUBLIC_API_URL')).pathname, oidcAuthority: new URL(env('OIDC_ISSUER')).pathname, oidcClientId: env('OIDC_CLIENT_ID') });
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      });
    },
  };
}

const require = createRequire(import.meta.url);
const SHARED_ID = 'd4-shared:';

/** The page's policy (production builds); styles allow inline `style` attributes, which React uses. */
const contentSecurityPolicy = (importMap: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

/**
 * Builds every shared package (`@d4/web-platform/shared`) as an entry and writes the page's import map, so
 * lifecycle modules import the shell's copies (P6 spike). Production builds only.
 */
function sharedImportMap(): Plugin {
  return {
    name: 'd4-shared-import-map',
    apply: 'build',
    config: () => ({
      build: {
        rollupOptions: {
          input: { index: 'index.html', ...Object.fromEntries(SHARED.map((s) => [`shared/${s.replace(/^@/, '').replace(/\//g, '-')}`, SHARED_ID + s])) },
          // Keep the shared entries' exports, which nothing in the shell itself imports.
          preserveEntrySignatures: 'strict',
        },
      },
    }),
    resolveId: (id) => (id.startsWith(SHARED_ID) ? `\0${id}` : undefined),
    load(id) {
      if (!id.startsWith(`\0${SHARED_ID}`)) return;
      const spec = id.slice(SHARED_ID.length + 1);
      if (!COMMONJS.has(spec)) return `export * from '${spec}';`;
      const names = Object.keys(require(spec) as object).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'default');
      return `import m from '${spec}';\nexport default m;\nexport const { ${names.join(', ')} } = m;`;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const imports: Record<string, string> = {};
        for (const chunk of Object.values(ctx.bundle ?? {}))
          if (chunk.type === 'chunk' && chunk.facadeModuleId?.startsWith(`\0${SHARED_ID}`)) imports[chunk.facadeModuleId.slice(SHARED_ID.length + 1)] = `/${chunk.fileName}`;
        const importMap = JSON.stringify({ imports });
        return [
          // Scripts only from this origin, plus this one inline import map (by hash): a registered
          // module can only run code the platform serves under /mfe/ (D70).
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(importMap) }, injectTo: 'head-prepend' },
          { tag: 'script', attrs: { type: 'importmap' }, children: importMap, injectTo: 'head-prepend' },
        ];
      },
    },
  };
}

export default defineConfig({
  // Lifecycle modules are imported at run time (the module registry) and share packages through the import map.
  plugins: [react(), runtimeConfig(), sharedImportMap()],
  // __D4_SHARED__: the shared majors this shell provides; it refuses modules built against others.
  define: { __D4_SHARED__: JSON.stringify(sharedMajors(__dirname)) },
  resolve: { alias: [{ find: /^@tabler\/icons-react$/, replacement: tablerIcons }] },
  // deploy/dev.sh web: behind the gateway, so the HMR socket goes to the gateway's port.
  server: { port: 5174, strictPort: true, hmr: { clientPort: Number(process.env.GATEWAY_PORT) || undefined } },
  // The @d4 packages the browser uses ship ESM under the `browser` export condition.
  build: { sourcemap: true, target: 'es2022' },
});
