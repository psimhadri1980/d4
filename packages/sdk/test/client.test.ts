import { describe, expect, it } from 'vitest';
import { allElements, createClient, D4ApiError, waitForJob } from '../src';

type Call = { url: string; init: RequestInit };

/** A fetch that records calls and answers from a script. */
function fakeFetch(answers: ((c: Call) => Response)[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    return next(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createClient', () => {
  it('fills path parameters, repeats array query values and sends a fresh token', async () => {
    const { f, calls } = fakeFetch([json({ items: [], hasMore: false, endCursor: null })]);
    let n = 0;
    const d4 = createClient({ baseUrl: 'https://d4.test/', token: () => `t${++n}`, fetch: f });
    await d4.get('/v1/workspaces/{ws}/elements', { path: { ws: 'w 1' }, query: { type: 'DataProduct', first: 5 } });
    expect(calls[0]!.url).toBe('https://d4.test/v1/workspaces/w%201/elements?type=DataProduct&first=5');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer t1');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('sends JSON bodies and returns the parsed result', async () => {
    const { f, calls } = fakeFetch([json({ id: 'e1', type: 'DataProduct', attrs: { name: 'X' } }, 201)]);
    const d4 = createClient({ baseUrl: 'https://d4.test', token: 'tok', fetch: f });
    const el = await d4.post('/v1/workspaces/{ws}/elements', { path: { ws: 'w' }, body: { type: 'DataProduct', attrs: { name: 'X' } } });
    expect(el.id).toBe('e1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ type: 'DataProduct', attrs: { name: 'X' } });
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('turns error responses into D4ApiError with the API code', async () => {
    const { f } = fakeFetch([json({ error: 'QUOTA_EXCEEDED', message: 'The plan allows 0 elements; 3 in use', ruleId: 'elements' }, 403), () => new Response(null, { status: 204 })]);
    const d4 = createClient({ baseUrl: 'https://d4.test', fetch: f });
    const err = await d4.post('/v1/workspaces/{ws}/elements', { path: { ws: 'w' }, body: { type: 'DataProduct', attrs: {} } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D4ApiError);
    expect(err).toMatchObject({ status: 403, code: 'QUOTA_EXCEEDED', ruleId: 'elements', message: 'The plan allows 0 elements; 3 in use' });
    await expect(d4.delete('/v1/admin/webhooks/{id}', { path: { id: 'h1' } })).resolves.toBeUndefined();
  });

  it('checks paths, parameters and bodies at compile time', () => {
    const d4 = createClient({ baseUrl: 'https://d4.test', fetch: (() => Promise.reject(new Error('not called'))) as unknown as typeof fetch });
    const never = () => {
      // @ts-expect-error unknown path
      void d4.get('/v1/nope');
      // @ts-expect-error path parameter missing
      void d4.get('/v1/workspaces/{ws}/elements', {});
      // @ts-expect-error body has the wrong shape
      void d4.post('/v1/workspaces/{ws}/elements', { path: { ws: 'w' }, body: { name: 'x' } });
      // @ts-expect-error no such method on this path
      void d4.delete('/v1/workspaces');
      // Paths without parameters need no options.
      void d4.get('/v1/workspaces');
    };
    expect(typeof never).toBe('function');
  });
});

describe('helpers', () => {
  it('pages through every element', async () => {
    const { f, calls } = fakeFetch([
      json({ items: [{ id: 'a' }, { id: 'b' }], hasMore: true, endCursor: 'b' }),
      json({ items: [{ id: 'c' }], hasMore: false, endCursor: null }),
    ]);
    const d4 = createClient({ baseUrl: 'https://d4.test', fetch: f });
    const ids: string[] = [];
    for await (const el of allElements(d4, 'w', { type: 'DataStore', first: 2 })) ids.push(el.id);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(calls[1]!.url).toContain('after=b');
  });

  it('waits for a job to finish', async () => {
    const { f } = fakeFetch([json({ id: 'j', status: 'running' }), json({ id: 'j', status: 'succeeded', result: { ok: true } })]);
    const d4 = createClient({ baseUrl: 'https://d4.test', fetch: f });
    expect(await waitForJob(d4, 'w', 'j', { intervalMs: 1 })).toMatchObject({ status: 'succeeded' });
  });
});
