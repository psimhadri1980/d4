# @d4/web-platform

What every D4 web module shares, so modules never import each other:

- **Start-up:** `loadRuntimeConfig()` reads `/config.json`; `config` holds the API URL and OIDC settings.
- **Sign-in:** `AuthProvider`, `useAuth()` and `userManager()` (oidc-client-ts, created on first use).
- **API:** `d4()` is the typed `@d4/sdk` client signed in as the current user; `api` holds the
  calls several modules make; `downloadFile()` fetches file responses. Errors are `D4ApiError`.
- **Queries:** `createQueryClient()` and `keys`, the keys of shared queries (invalidate these after
  changes other modules show).
- **The user and the view:** `useMe()`, `useAccess()`, `useRegistry(ws)`, `ViewProvider`/`useView()`.
- **The module contract:** `D4Module` (`id`, `contract`, `nav`, `routes`) and the navigation types.

Browser only. Peer dependencies: `react`, `react-router-dom`, `@tanstack/react-query`,
`oidc-client-ts` and `@tabler/icons-react`.
