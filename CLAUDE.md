# D4: notes for AI coding sessions

Read [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) before changing code. It holds the ground rules, repo map, request flows, recipes, test matrix, error contract and known pitfalls.

Essentials:
- **Docker is the source of truth.** Use `deploy/dev.sh` (`up`, `test`, `e2e`, `sample`, `cli`, `token`) and the container commands in the guide, including regenerating `pnpm-lock.yaml` after any `package.json` change.
- **Web work on local Node (optional):** `deploy/dev.sh web-local` (Vite with hot reload on :5173, stops the web container), `web-check`, `e2e-local`; after committing, `deploy/dev.sh web-deploy` puts the change back into the container. Node is at `/opt/homebrew/bin` (not on the default PATH); pnpm runs via `npx pnpm@<pinned>`.
- **Before committing:** run `deploy/dev.sh test`, then `deploy/dev.sh e2e --retries=0`, plus typecheck and lint. Commit one logical change at a time.
- **Never let users send raw Cypher.** Catalog queries go through the checks in `packages/cypher`. Only `TenantGraphService` opens Neo4j connections.
- **Metamodel:** changes go in `packages/metamodel/starter.yaml` with a version bump. Never hard-code type lists.
- **Web:** port 5173 is required (OIDC). Use `useId()` for field ids, an explicit empty option in list boxes, and theme tokens for colours.
- **Recording decisions:** add a row to the decision log in `docs/PLAN.md`.
