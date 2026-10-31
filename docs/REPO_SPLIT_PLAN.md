# Splitting D4 into three repositories (proposal, 2026-10-31)

> **Superseded** by [ADR 0008](adr/0008-repository-structure.md): D4 stays one repository; web modules
> became independently released plugins instead (D70–D73). Kept for the analysis.

Goal: `d4-web`, `d4-api` and `d4-infra`, each building and testing on its own, so a one-line change
builds and tests only the repository (and package) it touches. Working across them stays easy.

## 1. Where the monorepo couples things today

Internal dependencies (from each `package.json`):

| Workspace | Depends on |
|---|---|
| `apps/web` | `web-platform`, `ui-kit`, `core`, `metamodel`, `codecs` |
| `ui-kit` | `web-platform`, `core`, `metamodel`, `render` |
| `web-platform` | `sdk`, `metamodel` |
| `apps/web-admin` | `web-platform` |
| `apps/api` | `codecs`, `config`, `connectors`, `core`, `cypher`, `db`, `graph`, `infra`, `jobs`, `metamodel`, `runtime`, `sdk` |
| `worker`, `renderer`, `ops` | `config`, `infra`, `jobs`, `runtime`, `render`, `db`, `cypher`, `metamodel` |
| `sdk` | generated from the API's OpenAPI document (`apps/api/dist/scripts/openapi.js`) |
| `gateway`, `e2e`, `mocks/*`, `deploy/` | nothing at build time; they meet the apps at run time (images, env, URLs) |

So there are exactly **two build-time seams** between web and the backend:

1. **The API contract**: `@d4/sdk` (OpenAPI document plus generated types).
2. **Shared domain code**: the web app uses a small, pure slice of `core` (lifecycle states,
   lane and matrix kinds, `matrixToCsv`, element and roadmap types), `metamodel` (types and
   `MetamodelRegistry`), `codecs/roadmap` (CSV/Mermaid) and `render` (Gantt geometry). About 20
   imports in total; none of it touches a database.

And one **run-time seam** to infra: container images, the env contract (`deploy/env`), the
gateway paths (`/`, `/api`, `/auth`, `/mfe/<name>/`) and the Keycloak realm.

Everything else is already one-sided. That is what makes a clean split possible.

## 2. What goes where

| `d4-api` (backend, the producer) | `d4-web` (front end) | `d4-infra` (platform) |
|---|---|---|
| `apps/api`, `worker`, `renderer`, `ops` (migrations, seeds), `cli` | `apps/web` (shell), `web-admin`, `web-hello`, later the other modules | `deploy/` (compose, env, scripts), `apps/gateway`, Keycloak realm, OTel/Grafana |
| `packages/config`, `connectors`, `cypher`, `db`, `graph`, `infra`, `jobs`, `runtime` | `packages/web-platform`, `ui-kit` | `mocks/s3`, `mocks/smtp` |
| **Published:** `@d4/core`, `metamodel`, `codecs`, `render` (shared domain), `@d4/sdk` (API contract) | **Consumes** them as versioned npm packages | `apps/e2e` (system tests across pinned versions) |
| **Images:** `d4-api`, `d4-worker`, `d4-renderer`, `d4-ops` | **Images:** `d4-web`, `d4-web-<module>` | `versions.env`: which image tags make up a release |

Why the domain packages stay in `d4-api` rather than a fourth repository: the backend changes them
far more often, and their tests need the backend's fixtures. They are published from there, like
the SDK. If the web app ends up driving them, move them to a `d4-domain` repository later; the
packages and their versions stay the same, so consumers notice nothing.

## 3. The contracts that replace "build everything"

| Seam | Producer | Contract | How the consumer checks it |
|---|---|---|---|
| API | `d4-api` | `@d4/sdk` with `openapi.json`, semver: a breaking change to the document is a major version (checked in CI with an OpenAPI diff) | `d4-web` typechecks against the pinned SDK; its browser tests run against the API **image** of the same version |
| Domain | `d4-api` | `@d4/core`, `metamodel`, `codecs`, `render` with semver (Changesets) | Typecheck plus unit tests in `d4-web` |
| Images | `d4-api`, `d4-web` | `ghcr.io/<owner>/d4-*:<version>`; env variables in `deploy/env` documented per image; `/healthz` and `/readyz` | `d4-infra` smoke and system tests on the pinned set in `versions.env` |
| Web modules | `d4-web` | Lifecycle contract 2 (D64) and the registry (D65) | Contract tests in `d4-web`; the registry decides what runs |
| Schema | `d4-api` (`ops`) | Migrations ship in the `d4-ops` image; `dev-infra.sh migrate` runs the pinned one | API integration tests own them |

The rule that makes this fast: **a consumer never builds the producer**. It pulls a published
package or image of a known version.

## 4. What each change builds and tests

| You change | Builds | Tests | Typical time |
|---|---|---|---|
| A web screen | `d4-web`: that module | Its unit tests, typecheck and lint (local Node); its browser specs against pinned API images | seconds, then about 15 s per spec |
| A web-platform/ui-kit file | `d4-web`: the package plus its dependents in `d4-web` | Same, for the dependents | under a minute |
| An API handler | `d4-api`: `@d4/api` (turbo cache for the rest) | The package's tests with the infra services; OpenAPI diff | seconds to a minute |
| A shared domain package | `d4-api`: the package and its dependents | Its tests; publish a new version; `d4-web` picks it up when it bumps | Bump in `d4-web` is a separate, deliberate change |
| Compose, gateway, env | `d4-infra` | Smoke plus the affected system specs on `versions.env` | under a minute, no app build |
| A release | Nothing new | `d4-infra` runs the full system suite against the candidate `versions.env` | Once per release, not per change |

`test.sh all` becomes the release check in `d4-infra`, not something a developer waits on.

## 5. Working on all three together

Clone the three repositories side by side:

```
~/workspaces/d4/
  d4-api/    d4-web/    d4-infra/
```

- **Default: each repository on its own.** It uses published packages and images; nothing else
  needs to be checked out. `d4-infra` brings up the stack from `versions.env` (pulled images, no
  builds).
- **Run one side from source.** `d4-infra/deploy/dev.sh web --src ../d4-web` (or `api --src
  ../d4-api`) runs that app on local Node behind the gateway on `localhost`, as `dev.sh` does
  today, while `d4.localhost` keeps serving the pinned images (D67). `dev-deploy.sh web --src
  ../d4-web` builds a local image from that checkout instead of pulling.
- **Change a contract and its consumer together** (for example a new API field shown in the UI):
  1. In `d4-api`, change the endpoint and regenerate the SDK.
  2. In `d4-web`, run `pnpm d4:link ../d4-api` to link `@d4/sdk` and the domain packages to the
     sibling checkout. The script edits only a git-ignored overrides file, so the link is never
     committed. Develop both sides with hot reload.
  3. Merge `d4-api` first: CI publishes the SDK and images. Then `d4-web` unlinks, bumps the
     version and merges. Renovate (or a small bot) can open these bump PRs automatically.
  4. `d4-infra` bumps `versions.env`; its system suite is the integration check.
- **Additive API changes first.** Add the field, release, use it in the web app, then remove the
  old one in a later major. This keeps "merge the API first" safe without cross-repository locks.
- **One place for the tools.** `d4-infra` holds the dev scripts and env layering; the app
  repositories carry only their own build and test scripts and a `README` link to `d4-infra`.

## 6. How to get there (phases)

Each phase is useful on its own and can stop there.

**S0: boundaries inside the monorepo (days; most of the speed-up).**
- `test.sh affected`: `turbo run build test typecheck lint --filter=...[origin/main]`, so only the
  packages a branch changed (and their dependents) run.
- Split CI into `web`, `api` and `infra` jobs selected by path, each using that filter.
- Move the web app's imports of domain code behind the packages' public entry points, and add an
  ESLint rule: web packages import only `sdk`, `core`, `metamodel`, `codecs`, `render`,
  `web-platform`, `ui-kit`. Backend packages never import web ones.
- Generate the SDK from a committed `openapi.json` rather than the built API, so the web app no
  longer needs the API built.

**S1: publishable contracts (about a week).**
- Changesets for `core`, `metamodel`, `codecs`, `render` and `sdk`; publish to GitHub Packages
  (npm) from CI, with an OpenAPI breaking-change check.
- CI pushes images to GHCR, tagged with the version and the commit.
- `d4-infra`'s compose files reference `${D4_API_IMAGE}` and the like from `versions.env`, with a
  `--src` switch for local builds.
- The web packages consume the domain packages and the SDK by version (`workspace:` links only
  until the split).

**S2: extract `d4-infra`.** Use `git filter-repo` to keep the history of `deploy/`,
`apps/gateway`, `apps/e2e` and `mocks/`. Point the stack at images. The monorepo keeps working
against it.

**S3: extract `d4-web`.** Same for `apps/web*`, `web-platform` and `ui-kit`. It consumes the
published SDK and domain packages and runs browser specs against pinned API images through
`d4-infra`.

**S4: what is left becomes `d4-api`** (rename the monorepo, so its history, issues and stars stay
with it).

## 7. Risks and how they are handled

| Risk | Mitigation |
|---|---|
| Version drift: the web app on an old SDK | Renovate bump PRs; the OpenAPI diff marks breaking changes; `versions.env` pins a tested set |
| A cross-repository change needs two merges in order | Additive changes first; `d4:link` for local development; system tests in `d4-infra` |
| Duplicated tooling (ESLint, tsconfig, Node and pnpm pins) | A small published `@d4/tooling` package (shared configs), or copies kept aligned by Renovate |
| Browser tests no longer cover "everything at HEAD" | Each repository tests its side against pinned versions of the others; `d4-infra` runs the full suite per release candidate |
| Registry access (credentials for GitHub Packages and GHCR) | A read-only token in each developer's `~/.npmrc`; CI uses `GITHUB_TOKEN` |
| History split | `git filter-repo` per repository; the monorepo is archived read-only at the split commit |

## 8. Decisions needed

1. **Registry:** GitHub Packages and GHCR (recommended, since the code is on GitHub), or a
   self-hosted Verdaccio and a container registry.
2. **Domain packages:** published from `d4-api` (recommended), or a fourth repository `d4-domain`.
3. **Start with S0:** it gives most of the speed-up without moving any code, and shows whether the
   boundaries hold before the repositories split.
