// The README example, compiled with the package typecheck so the docs stay correct. Not run.
import { allElements, createClient, D4ApiError, waitForJob } from '../src';

declare function getAccessToken(): Promise<string>;

export async function readmeExample() {
  const d4 = createClient({ baseUrl: 'https://d4.example.com', token: () => getAccessToken() });

  const [ws] = await d4.get('/v1/workspaces');
  if (!ws) return;
  const el = await d4.post('/v1/workspaces/{ws}/elements', { path: { ws: ws.id }, body: { type: 'DataProduct', attrs: { name: 'Customer' } } });

  try {
    await d4.patch('/v1/workspaces/{ws}/elements/{id}', { path: { ws: ws.id, id: el.id }, body: { expectedVersion: el.version, set: { lifecycle: 'PROPOSED' } } });
  } catch (e) {
    if (e instanceof D4ApiError && e.code === 'VERSION_CONFLICT') {
      // re-read and retry
    }
  }

  for await (const p of allElements(d4, ws.id, { type: 'DataProduct' })) console.log(p.attrs['name']);

  const job = await d4.post('/v1/workspaces/{ws}/jobs/export', { path: { ws: ws.id }, body: { format: 'xlsx' } });
  return waitForJob(d4, ws.id, job.id);
}
