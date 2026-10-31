# P6 spike: single-spa with an import map (2026-10-31)

Branch `spike/p6-single-spa`, on top of the Module Federation spike
([p6-module-federation.md](p6-module-federation.md)). Question: can single-spa make the shell
agnostic about how a module is built and which framework it uses, and how does it compare with
Module Federation?

**Answer: yes, and it fixes both problems the Module Federation spike found.** The contract becomes
lifecycles plus a menu manifest; modules are plain ES modules; shared packages come from the
shell through a native import map. The cost is in our own code (a framework-neutral platform
object, a router per module), not in tooling.

## What was built

- **Contract 2** (`packages/web-platform/src/lifecycle.ts`): a module is an ES module exporting
  `manifest` (id, contract, menu as data: icon by name, `requires` a role) and the single-spa
  lifecycles `bootstrap`, `mount`, `unmount`. The module owns every path under `/w/:ws/<id>`.
- **Platform** (same file): what the shell passes in `props.platform`, with no React in it:
  settings, `token()`, the typed `client()`, the shell's `queryClient`, `workspace()`,
  `navigate()`. `ModuleRoot` (`module-root.tsx`) is the React binding: the shared query cache and a
  router of the module's own.
- **Shell** (`apps/web/src/lifecycle.ts`): after it renders, imports each module listed in
  `/config.json` (`import(url)`, in parallel), checks the manifest and registers it with single-spa;
  `Layout` holds the page slot and starts single-spa. The menu (`nav.tsx`) adds manifests as they
  arrive; `ModuleOutlet` shows "Loading…" or "unavailable" for a module path that is not ready.
  `localStorage['d4:module:<name>'] = '<url>'` loads one module from elsewhere.
- **Import map** (`apps/web/vite.config.ts`, `shared.ts`): the shell build emits React, ReactDOM,
  React Router, React Query, `@d4/web-platform` and `@d4/ui-kit` as entries of their own and writes
  an import map for them into `index.html`. CommonJS packages get an ES wrapper listing their
  exports.
- **Admin** (`apps/web-admin/src/admin.tsx`): a Vite library build, shared packages external,
  wrapped with `single-spa-react`. Output: `admin.js` (10.9 kB), `admin.css`, one lazy page chunk.
  The pages still live in `apps/web/src/modules/admin`.
- **Hello** (`apps/web-hello/hello.js`): one hand-written ES module, no framework, no build. Uses
  only `props.platform` and the shared CSS classes.
- Both are served by the `web-admin` container under `/mfe/<name>/`; the gateway routes `/mfe/`.
- Versions: `single-spa` 6.0.3, `single-spa-react` 6.0.2, Vite 5.4.

## Results

| Check | Module Federation spike | single-spa spike |
|---|---|---|
| Browser suite with admin as a module | 72 passed | 72 passed |
| Singletons | Held, through share negotiation; ~150 kB of fallbacks downloaded per remote | Held by construction: the module only fetches `admin.js`, `admin.css` and its page chunk |
| Module server stopped | Shell blocked 8 s (the runtime never rejected), then worked without admin | Imports failed at ~0.13 s; the shell never waited; menu without the modules; a deep link stays on its URL and shows "unavailable" |
| Admin page, production | Rendered at 0.23 s | Data on screen at ~0.2 s |
| Local module in the deployed shell | Gateway change, ~4.9 s render, preamble and JSX fixes | `localStorage` override to a local `vite build --watch` + `vite preview`; no gateway change; loaded in ~0.12 s |
| Redeploy one module | Only `web-admin` recreated | Same |
| A second framework | Not possible (one React tree) | The plain JavaScript module mounts, reads the signed-in user from the shared cache and navigates the shell |
| Module build | Federation plugin in every module | A plain Vite library build; nothing D4-specific except the external list |

## Problems found

1. **Vite drops entry exports in app builds.** The shared entries need
   `preserveEntrySignatures: 'strict'`.
2. **CommonJS packages** (React, ReactDOM) have no static named exports; an `export *` wrapper
   gives none. The plugin lists them from `require()` at build time.
3. **The page slot must exist before a module mounts.** single-spa starts from `Layout`'s effect;
   modules registered earlier wait.
4. **`/v1/me` is fetched twice** on a module page: the module's own observer refetches the shell's
   stale entry. Harmless; a `staleTime` on `me` would avoid it.
5. **Shell dev mode (`vite` dev server) has no import map**, so modules cannot load into it as
   built. Production shell plus local module (above) works. A dev import map (or
   `vite-plugin-single-spa`) is needed before P6.
6. **No hot reload for a module**: the local loop is watch-build and page reload (~1 s). Vite's dev
   server pre-bundles React into its own copy, which breaks the singletons. Acceptable for P6;
   revisit with `vite-plugin-single-spa` 2.x.

## What it means for P6

- Replace the `D4Module` route contract with contract 2 for modules that load at run time. Built-in
  modules can stay route-based in the shell; the menu builder already merges both.
- Split `@d4/web-platform` along the line drawn here: the neutral `Platform` object, and React
  bindings (`ModuleRoot`, hooks). A non-React module needs only the former.
- `@d4/ui-kit` components remain React only. Non-React modules get the stylesheets (tokens,
  `base.css`, `app.css`) and class names; web components only if a second framework is adopted for
  real.
- Keep the shared list short and versioned with the shell: a module built against another major
  of a shared package must not load. Contract checks should cover it.
- The loader is a function of the URL (`import()` today). Module Federation could serve as a
  different loader behind the same contract if ever needed; nothing above depends on it.

## Module registry (added after the spike, D65)

- Postgres `web_modules` per tenant (migration 0013), `WebModuleStore`, seeded with `admin` and
  `hello` for the local tenant.
- API: `GET /v1/web-modules` (any member; enabled modules; ETag and 304), and for admins
  `GET /v1/admin/web-modules`, `PUT /v1/admin/web-modules/{name}` (register or new release),
  `DELETE`. Entries must be same-origin paths under `/mfe/<name>/`, without `.`/`..` segments;
  the contract must be one the shell supports.
- Admin › Modules lists modules with their metadata and lets an admin register, release, turn
  off and remove them.
- Hot loading (`apps/web/src/lifecycle.ts`): the shell reads the registry once signed in, then every
  30 s and when the tab comes back into view. New modules load; a changed release is unmounted,
  re-imported as `<entry>?v=<version>` and mounted again; removed or turned-off modules unmount and
  leave the menu. `/config.json` no longer lists modules.

## Not covered

- Shell in dev mode with modules (finding 5), contract tests, resilience cases in the e2e suite,
  the other four modules.
- Moving the admin pages into `apps/web-admin`; `lint` for `apps/web-admin` and `apps/web-hello`.
- Several modules active at once (single-spa supports it; D4 shows one page at a time).

## Module releases from a bucket (D70, spike)

Question: can web modules ship as uploads to a store, served by the gateway, instead of images?

- **Store:** S3 bucket `d4-web-modules` (`S3_WEB_MODULES_BUCKET`). The mock has public-read buckets
  (`S3_MOCK_PUBLIC_BUCKETS`) for unsigned GET/HEAD, as a bucket policy would in S3.
- **Control plane:** `POST /v1/admin/web-modules/{name}/releases` (admin) takes a manifest (name,
  semver, contract, entry, framework, SHA-256 per file) and the files (base64). It checks name,
  contract, file list, hashes, paths, types and a 5 MB limit, refuses an existing version (409),
  and writes `<tenant>/<name>/<version>/…` with `immutable` caching, the manifest last. It does not
  activate: `PUT /v1/admin/web-modules/{name}` with the returned entry does, per tenant; a rollback
  is the same PUT with an older version. Releases are per tenant, so an admin can only register code
  their own tenant uploaded (`/mfe/_r/<tenant>/<name>/`).
- **Serving:** the gateway's `/mfe/_r/` reads the bucket, GET only, without auth headers or cookies,
  query dropped (the version is in the path). `/mfe/<name>/` still serves the module image.
- **Publishing:** `deploy/mfe-publish.sh <name> <dist> <version> [--activate]`.

| Check | Result |
|---|---|
| Publish and activate admin 0.2.0 | under 1 s (an image rebuild and restart before) |
| Served file | 200, `text/javascript`, `public, max-age=31536000, immutable`; PUT through the gateway 403 |
| Admin page from the release | entry, stylesheet and lazy chunk all from `/mfe/_r/t_local/admin/0.2.0/` |
| Hot swap to 0.3.0 on an open page | 4 s, no reload, same screen |
| Rollback to 0.2.0 | 258 ms to activate; the open page followed within the 30 s poll |
| Tests | API: registry suite 4/4 (release checks, 409, 403, other tenant's path); S3 mock 12/12; browser admin and navigation specs 11/11 on d4.localhost |

Found: the shell's `?v=` query made S3 treat the request as signed; the gateway now drops it.

Hardened afterwards:

- **Shared versions:** a module's manifest records the major versions of the shared packages it was
  built against (`shared`, from `sharedMajors()` in `@d4/web-platform/shared` at build time); the
  shell, built with its own, refuses a mismatch through `lifecycleProblems()` and shows the module
  as unavailable.
- **Content security policy** (production shell, a `<meta>` tag): scripts only from this origin
  plus the inline import map by hash; checked in the browser that an injected inline script and a
  script from another origin are refused, and the full browser suite (72) passes under it.
- **Cleanup:** `GET /v1/admin/web-modules/{name}/releases` lists a tenant's versions (with the
  active one), `DELETE …/releases/{version}` deletes an inactive one (409 for the active one);
  `mfe-publish.sh --keep N` keeps the newest N.
- **OpenAPI and SDK** cover the release endpoints.

Still open: the shell itself as a release, retiring the module image (admin and hello still also
ship in it), integrity hashes on load (browsers cannot check them for `import()`; immutable
same-origin paths plus the policy stand in), and uploads larger than the gateway's 25 MB limit.

## All six modules as lifecycle apps (D73)

Reporting, queries, data, plan and explore follow admin out of the shell, one commit each, into
`apps/web-<name>`; the shell (`apps/web`) keeps sign-in, the layout, the menu, search and the
module loader, and no screens. The static `D4Module` contract is gone.

- **Paths:** a manifest may own several top-level segments (`paths`, default its id), so pages keep
  their URLs (`/w/:ws/reports`, `/w/:ws/jobs`, …); explore also owns the workspace home
  (`home: true`). A deep link waits while modules load, then goes to its owner.
- **Menu:** icons are named in the manifest and mapped by the shell; visibility is `requires` (a
  role in `Access`).
- **Build:** each module is a Vite library build with its own tests (a contract test, plus the
  catalog and roadmap tests that moved with queries and plan). The module image builds every
  `@d4/web-*` app; the seed registers all six; releases 1.0.0 of all six are active locally.
- **Verified:** `test.sh all` passes (static, 43 integration tasks including API 70, browser 72) with all six served from their releases. The first run found three gaps, fixed: module pages now get the model view (`ModuleRoot` provides it), lay out as children of `.content` (`display: contents` wrappers), and the collapsed sidebar releases focus after navigating.
