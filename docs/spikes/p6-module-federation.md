# P6 spike: Module Federation with Vite (2026-10-31)

Branch `spike/p6-module-federation`, on top of P5. Question: can `@module-federation/vite` carry
P6 (section 4.6 of [REFACTOR_PLAN.md](../REFACTOR_PLAN.md)), or do we fall back to Rsbuild?

**Answer: go with the Vite plugin.** Production builds work as designed. Dev mode works with three
small, contained fixes. Two findings change the P6 design (start-up must not wait for remotes;
dev remotes load slowly).

## What was built

- `apps/web` is the host (`federation({ name: 'shell', remotes: {}, shared })`). At start-up
  `src/remotes.ts` reads the remotes from `/config.json`, registers them with
  `@module-federation/runtime` and loads each `<name>/module` with a timeout; the descriptors
  join the static modules.
- `apps/web-admin` is a remote: `base: '/mfe/admin/'`, exposes `./module`, which for the spike is
  the existing `apps/web/src/modules/admin/module.tsx` (no code moved). Own `Containerfile` (nginx,
  `remoteEntry.js` and `mf-manifest.json` served `no-cache`, hashed assets immutable), compose
  service `web-admin`, gateway location `/mfe/admin/` (`UPSTREAM_WEB_ADMIN`).
- `/config.json` gains `remotes` from `D4_WEB_REMOTES` (`admin=/mfe/admin/remoteEntry.js`).
- Shared (`apps/web/federation.shared.ts`): `react`, `react-dom`, `react-router-dom`,
  `@tanstack/react-query`, `@d4/web-platform`, `@d4/ui-kit`, `@d4/core`, `@d4/metamodel`, all
  singletons.
- Versions: `@module-federation/vite` 1.23.5 (runtime 2.9.2), Vite 5.4.

## Results

| Check | Result |
|---|---|
| Builds | Shell and remote build. The remote is 5.2 MB with source maps; the admin page is a 17 kB lazy chunk |
| Browser suite with admin loaded from the remote | 72 passed |
| Singletons | The remote fetches no React, router or react-query chunks; its API calls go through the shell's signed-in `web-platform` (a second copy would have no API URL). The `loadShare` fallbacks (~150 kB) download but do not run |
| Remote CSS | Injected with the module; admin pages look as before |
| Remote stopped | The rest of the app works; Admin is absent from the menu |
| Redeploy one remote | `dev-deploy.sh web-admin` rebuilt and recreated only `web-admin`; the next page load showed the change with the shell untouched |
| Rollback | Redeploying the previous source restored the old text, again only `web-admin` recreated |
| Timing, production remote | Admin page rendered at 0.23 s after navigation (a built-in page: 0.27 s) |
| Dev remote (`vite` dev server behind the gateway, production shell) | Works after three fixes below; page renders at ~4.9 s although the remote's 225 files arrive by 0.45 s |

## Problems found and fixes

1. **Remote entry is an ES module.** `registerRemotes` needs `type: 'module'`, or the entry fails
   with "Cannot use import statement outside a module".
2. **React Refresh preamble (dev remote).** `@vitejs/plugin-react` in dev throws "can't detect
   preamble" when the page is not served by that Vite server. Fix: a dev-only plugin makes the
   exposed module import `apps/web-admin/dev-preamble.ts` first, which installs the preamble from
   the remote's own `/@react-refresh`.
3. **`jsxDEV is not a function` (dev remote, production shell).** The shared React is the shell's
   production build. Fix: compile the remote's JSX for the production runtime in dev too
   (`esbuild: { jsx: 'automatic', jsxDev: false }`). React dev warnings in the remote are lost
   while the shell is a production build; with `dev.sh web` both are dev builds.
4. **The plugin's type generation** fails without a remote `tsconfig.json`; turned off
   (`dts: false`). We share types through workspace packages, not MF type archives.
5. **`dev-deploy.sh` did not know `web-*` names** and fell back to redeploying everything. Fixed.

## Findings that change the P6 design

- **Start-up must not wait for remotes.** With the remote stopped, the gateway's 502 came back in
  36 ms, but the runtime's load promise did not reject, so the shell waited the full 8 s timeout
  before rendering. P6 should render the shell at once and mount each remote's menu items and
  routes when it arrives, with the "unavailable" notice on failure (as the design says), and a
  deep link into a remote should show a loading state rather than redirect to `/`.
- **Dev remotes load slowly in a production shell** (~4.4 s after the files arrive, likely the
  plugin's dev-mode shared-scope negotiation). Acceptable for `dev.sh web-<name>`, but worth an
  issue upstream or a look at the plugin's `dev` options before P6.
- **The remote's `loadShare` fallbacks** add ~150 kB of downloads per remote. Acceptable; could be
  trimmed later with `import: false` on shared entries the shell always provides.

## Not covered

- The shell itself in dev mode (`dev.sh web`) with remotes: this machine has Node 22, and the
  check above used the production shell.
- Contract tests, the "unavailable" UI, resilience e2e cases, the other five remotes, and moving
  each module's code into its `apps/web-<name>` (the spike's remote reads `apps/web/src`).
- `typecheck`, `lint` and `knip` were not extended to `apps/web-admin`.
