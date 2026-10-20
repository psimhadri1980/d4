# @d4/sdk

Typed client for the D4 REST API. Paths, parameters, request bodies and results are checked at
compile time against the API's OpenAPI document, which ships in this package (`openapi.json`).
No runtime dependencies; needs a `fetch` (Node 20+ or any browser).

```ts
import { allElements, createClient, D4ApiError, waitForJob } from '@d4/sdk';

const d4 = createClient({
  baseUrl: 'https://d4.example.com',
  token: () => getAccessToken(), // a string, or a function called before every request
});

const [ws] = await d4.get('/v1/workspaces');
const el = await d4.post('/v1/workspaces/{ws}/elements', {
  path: { ws: ws.id },
  body: { type: 'DataProduct', attrs: { name: 'Customer' } },
});

try {
  await d4.patch('/v1/workspaces/{ws}/elements/{id}', {
    path: { ws: ws.id, id: el.id },
    body: { expectedVersion: el.version, set: { lifecycle: 'PROPOSED' } },
  });
} catch (e) {
  if (e instanceof D4ApiError && e.code === 'VERSION_CONFLICT') {
    // someone else changed it: re-read and retry
  }
}

for await (const p of allElements(d4, ws.id, { type: 'DataProduct' })) console.log(p.attrs.name);

const job = await d4.post('/v1/workspaces/{ws}/jobs/export', { path: { ws: ws.id }, body: { format: 'xlsx' } });
const done = await waitForJob(d4, ws.id, job.id);
```

Errors are `D4ApiError` with `status`, `code` (`VALIDATION`, `NOT_FOUND`, `VERSION_CONFLICT`,
`RULE_VIOLATION`, `QUOTA_EXCEEDED`, `LOCKED`, …), `message`, `issues` and `ruleId`.

## Keeping it in step with the API

After changing an API route or schema (`apps/api/src/http/openapi.ts`):

```bash
pnpm --filter @d4/api build && pnpm --filter @d4/sdk generate
```

An API test fails when the shipped `openapi.json` differs from what the API serves, and another
when a route is missing from the document.
