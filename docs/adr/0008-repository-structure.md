# ADR 0008: Repository structure (one repository, web modules as plugins)

**Status:** Accepted, 2026-10-31. Supersedes the three-repository split planned in D69
([REPO_SPLIT_PLAN.md](../REPO_SPLIT_PLAN.md)). Records D73 and the build changes D66–D72.

## Context
A one-line change built and tested everything, and every web release meant an image build. We
considered four structures, each judged by two independent reviews against the code:

| | Structure | Verdict |
|---|---|---|
| A | One repository, features as full plugin slices (`plugins/<feature>/{web,api,jobs,db}`), backend plugins in host images | Later, one feature at a time |
| B | One repository per plugin, contracts published with semver | Only for outside plugin authors |
| C | One repository; web modules are independently built and released plugins; the backend a modular monolith | **Chosen** |
| D | Backend features as separate services | Only for one capability that needs isolation |

What decided it: the domain kernel (`metamodel`, `core`) sits under almost every package and still
changes; most changes cross web and API (29 of 104 recent commits touched both), which separate
repositories make slower; the code base is small (about 30k lines), so the cost was in what got
rebuilt and retested, not in compiling.

## Decision
- **One repository.** Speed comes from building and testing only what a change affects: honest
  turbo cache keys and `test.sh affected` (D71), CI with `--affected` on pull requests, backend
  images from `turbo prune`, and local Node first (D66).
- **Every web module is a plugin** (`apps/web-<name>`): an ES module with a manifest (menu,
  owned paths, shared-package majors) and single-spa lifecycles, checked by `lifecycleProblems()`
  in `@d4/web-platform`. The shell has no screens. A module imports only `@d4/web-platform`,
  `@d4/ui-kit`, `@d4/sdk` and domain packages (ESLint).
- **Modules ship as releases** (D70, D72): an upload checked by the API, stored immutably per
  tenant, served by the gateway, activated (or rolled back) per tenant in the registry, refused by
  the shell when its shared majors differ, and confined by a content security policy.
- **The backend stays one API process** with explicit seams: one feature list for the Nest
  modules and the OpenAPI document, and job handlers in a map by kind, so the renderer only takes
  render jobs.

## When to change
- **To A (backend plugins), one feature at a time,** when a second developer owns a feature, a
  backend feature must be enabled per tenant, or a backend one-line change still costs more than
  about five minutes of CI. Queries and the catalog are the cleanest first slice.
- **To B,** only when people outside the team build plugins without the source; even then publish
  `@d4/web-platform`, `@d4/ui-kit` and `@d4/sdk` rather than split the repository.
- **To D,** only for one capability that needs other scaling or isolation (for example connectors
  fetching untrusted URLs), never as the plugin model: ADR 0004 needs the graph write and the
  event log in one unit of work.

## Consequences
- A change to one module builds and tests that module (about 10 s locally); a release takes about
  a second and rolls back the same way.
- `@d4/web-platform` and `@d4/ui-kit` are shared by every module, so a change there affects all
  of them, and their majors gate which module builds the shell accepts.
- Several React trees run on one page (shell plus the mounted module); providers a page needs
  (query cache, router, model view) come from `ModuleRoot`.
