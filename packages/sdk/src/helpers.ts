import type { D4Client, Schemas } from './client';
import type { paths } from './schema';

/** The element list's filters (the paging cursor is handled here). */
export type ElementQuery = Omit<NonNullable<paths['/v1/workspaces/{ws}/elements']['get']['parameters']['query']>, 'after'>;

/**
 * Every element matching a filter, page by page (the API returns at most `first` per call).
 *
 *   for await (const el of allElements(d4, ws, { type: 'DataProduct' })) …
 */
export async function* allElements(client: D4Client, ws: string, query: ElementQuery = {}): AsyncGenerator<Schemas['Element']> {
  let after: string | undefined;
  for (;;) {
    const page = await client.get('/v1/workspaces/{ws}/elements', { path: { ws }, query: { first: 200, ...query, ...(after && { after }) } });
    yield* page.items;
    if (!page.hasMore || !page.endCursor) return;
    after = page.endCursor;
  }
}

/** Polls a background job until it succeeds or fails; resolves with the finished job. */
export async function waitForJob(
  client: D4Client,
  ws: string,
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Schemas['Job']> {
  const until = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const job = await client.get('/v1/workspaces/{ws}/jobs/{id}', { path: { ws, id }, ...(opts.signal && { signal: opts.signal }) });
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (Date.now() > until) throw new Error(`Job ${id} is still ${job.status} after ${Math.round((opts.timeoutMs ?? 600_000) / 1000)} s`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
  }
}
