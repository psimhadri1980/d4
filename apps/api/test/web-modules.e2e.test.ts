import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEO, PG, startHarness, type Harness } from './harness';

describe.skipIf(!PG || !NEO)('Web module registry API', () => {
  let h: Harness;
  let admin: string;
  let viewer: string;
  const release = { title: 'Plan', entry: '/mfe/plan/plan.js', version: '1.0.0', contract: 2, framework: 'react' };
  const enabled = (token: string, etag?: string) =>
    h.app.inject({ method: 'GET', url: '/v1/web-modules', headers: { authorization: `Bearer ${token}`, ...(etag && { 'if-none-match': etag }) } });

  beforeAll(async () => {
    h = await startHarness();
    [admin, viewer] = await Promise.all([h.sign('admin-m', ['admin']), h.sign('viewer-m', ['viewer'])]);
  });
  afterAll(() => h?.close());

  it('lists the seeded modules to any member, with an ETag', async () => {
    const res = await enabled(viewer);
    expect(res.statusCode).toBe(200);
    expect(res.json().modules.map((m: { name: string }) => m.name)).toEqual(['admin', 'hello']);
    expect((await enabled(viewer, res.headers.etag as string)).statusCode).toBe(304);
  });

  it('lets only admins register, release, turn off and remove modules', async () => {
    expect((await h.call('PUT', '/v1/admin/web-modules/plan', viewer, release)).status).toBe(403);
    const before = (await enabled(viewer)).headers.etag as string;

    const put = await h.call('PUT', '/v1/admin/web-modules/plan', admin, release);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: 'plan', version: '1.0.0', enabled: true, owner: null });
    const after = await enabled(viewer, before);
    expect(after.statusCode).toBe(200);
    expect(after.json().modules.map((m: { name: string }) => m.name)).toContain('plan');

    await h.call('PUT', '/v1/admin/web-modules/plan', admin, { ...release, version: '1.1.0', entry: '/mfe/plan/plan-1.1.js' });
    await h.call('PUT', '/v1/admin/web-modules/plan', admin, { ...release, version: '1.1.0', enabled: false });
    expect((await enabled(viewer)).json().modules.map((m: { name: string }) => m.name)).not.toContain('plan');
    expect((await h.call('GET', '/v1/admin/web-modules', admin)).body.find((m: { name: string }) => m.name === 'plan')).toMatchObject({ version: '1.1.0', enabled: false });

    expect((await h.call('DELETE', '/v1/admin/web-modules/plan', admin)).status).toBe(204);
    expect((await h.call('DELETE', '/v1/admin/web-modules/plan', admin)).status).toBe(404);
  });

  it('accepts only same-origin entries under the module path and known contracts', async () => {
    for (const body of [
      { ...release, entry: 'https://evil.example/plan.js' },
      { ...release, entry: '//evil.example/mfe/plan/plan.js' },
      { ...release, entry: '/mfe/plan/../../api/x.js' },
      { ...release, contract: 1 },
    ])
      expect((await h.call('PUT', '/v1/admin/web-modules/plan', admin, body)).status).toBe(400);
    expect((await h.call('PUT', '/v1/admin/web-modules/Bad_Name', admin, release)).status).toBe(400);
  });
});
