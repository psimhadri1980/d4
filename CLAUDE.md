# D4: notes for AI coding sessions

Read [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) before changing code. It holds the ground rules, repo map, request flows, recipes, test matrix, error contract and known pitfalls.

Essentials:
- **Containers (Podman) are the source of truth.** `deploy/dev-infra.sh` (infrastructure, tenants, token), `deploy/dev-deploy.sh` (build and start app containers, all or named), `deploy/test.sh` (static, unit, integration, e2e, smoke, all) and the container commands in the guide, including regenerating `pnpm-lock.yaml` after any `package.json` change.
- **Web work on local Node (optional):** `deploy/dev.sh web|api|worker|renderer` (hot reload, settings from `deploy/env/host.env`), `deploy/test.sh web --local`, `deploy/test.sh e2e` (local apps sit behind the gateway); after committing, `deploy/dev-deploy.sh web` puts the change back into the container. Node 24 (`.node-version`); pnpm runs via `npx pnpm@<pinned>`.
- **Before committing:** `deploy/test.sh all` is not required. For each touched app or package: build it, redeploy only the affected containers (`deploy/dev-deploy.sh <app>...`), then run its tests (`deploy/test.sh integration --filter <pkg>`, `deploy/test.sh web` for the shell) and only the browser specs covering the change (`deploy/test.sh e2e <spec> --retries=0`). Run `test.sh static` when types, exports or dependencies change. Commit one logical change at a time.
- **Never let users send raw Cypher.** Catalog queries go through the checks in `packages/cypher`. Only `TenantGraphService` opens Neo4j connections.
- **Metamodel:** changes go in `packages/metamodel/starter.yaml` with a version bump. Never hard-code type lists.
- **Gateway:** one origin, http://localhost:5173 (OIDC): web `/`, API `/api`, Keycloak `/auth`; no CORS, no other browser-facing ports.
- **Web:** a shell plus six modules (`apps/web/src/modules/`); a module imports only `@d4/web-platform`, `@d4/ui-kit` and domain packages, never another module (ESLint enforces it). Call the API through the typed client in `@d4/web-platform`. Use `useId()` for field ids, an explicit empty option in list boxes, and theme tokens for colours.
- **Settings:** `deploy/env/*.env` (layered) loaded through `@d4/config`; no hard-coded URLs or secret defaults. 
- **Recording decisions:** add a row to the decision log in `docs/PLAN.md`.
