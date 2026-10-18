import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseModelDocument } from '@d4/codecs';
import { NEO, PG, startHarness, type Harness } from './harness';

describe.skipIf(!PG || !NEO)('Query Catalog API', () => {
  let h: Harness;
  let admin: string;
  let viewer: string;
  let author: string;
  let steward: string;
  let keyToId: Record<string, string>;
  const ws = () => h.workspaceId;
  const bySlug = async (slug: string) =>
    ((await h.call('GET', '/v1/catalog', steward)).body as { id: string; slug: string }[]).find((q) => q.slug === slug)!;

  beforeAll(async () => {
    h = await startHarness();
    [admin, viewer, author, steward] = await Promise.all([
      h.sign('admin-c', ['admin']),
      h.sign('viewer-c', ['viewer']),
      h.sign('author-c', ['query-author']),
      h.sign('steward-c', ['query-steward']),
    ]);
    const doc = parseModelDocument(readFileSync(join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml'), 'utf8'));
    const res = await h.call('POST', `/v1/workspaces/${ws()}/import`, admin, doc);
    expect(res.body.ok).toBe(true);
    keyToId = res.body.keyToId;
  });
  afterAll(() => h?.close());

  it('documents the catalog endpoints in OpenAPI', async () => {
    const paths = Object.keys((await h.call('GET', '/v1/openapi.json')).body.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/v1/catalog',
        '/v1/catalog/{id}',
        '/v1/catalog/{id}/draft',
        '/v1/catalog/{id}/submit',
        '/v1/catalog/{id}/review',
        '/v1/catalog/{id}/versions/{version}/status',
        '/v1/catalog/{id}/grants',
        '/v1/catalog/{id}/executions',
        '/v1/workspaces/{ws}/catalog/{id}/run',
      ]),
    );
  });

  describe('system pack and discovery', () => {
    it('installs the system pack as certified, published entries', async () => {
      const list = (await h.call('GET', '/v1/catalog', steward)).body;
      expect(list.map((q: any) => q.slug)).toEqual(
        expect.arrayContaining(['impact-of-retirement', 'data-product-holders', 'process-crud-matrix']),
      );
      for (const q of list) expect(q).toMatchObject({ system: true, certified: true, publishedVersion: 1 });
    });

    it('shows viewers only what is granted to them, and supports search', async () => {
      const visible = (await h.call('GET', '/v1/catalog', viewer)).body;
      expect(visible).toHaveLength(7);
      const found = (await h.call('GET', '/v1/catalog?q=master', viewer)).body.map((q: any) => q.slug);
      expect(found).toEqual(expect.arrayContaining(['data-product-holders', 'data-products-without-master']));
      const none = (await h.call('GET', '/v1/catalog', await h.sign('nobody', ['planner']))).body;
      expect(none).toHaveLength(7);
    });

    it('detail hides grants from viewers but shows published versions', async () => {
      const q = await bySlug('impact-of-retirement');
      const d = (await h.call('GET', `/v1/catalog/${q.id}`, viewer)).body;
      expect(d.grants).toBeUndefined();
      expect(d.versions.map((v: any) => v.status)).toEqual(['published']);
      expect((await h.call('GET', `/v1/catalog/${q.id}`, steward)).body.grants).toEqual(
        expect.arrayContaining([{ principalType: 'role', principal: 'viewer' }]),
      );
    });
  });

  describe('running queries', () => {
    it('runs a system query on the sample', async () => {
      const q = await bySlug('process-crud-matrix');
      const res = await h.call('POST', `/v1/workspaces/${ws()}/catalog/${q.id}/run`, viewer, {
        params: { element: keyToId['bp-onboarding'] },
      });
      expect(res.status).toBe(200);
      expect(res.body.columns).toEqual(['seq', 'step', 'performedBy', 'dataProduct', 'operation']);
      expect(res.body.rows[0]).toMatchObject({ seq: 1, step: 'Capture client details', operation: 'CREATE' });
      expect(res.body).toMatchObject({ truncated: false, version: 1, status: 'published' });
    });

    it('applies date parameters (master hand-over)', async () => {
      const q = await bySlug('data-product-holders');
      const run = (asOf: string) =>
        h.call('POST', `/v1/workspaces/${ws()}/catalog/${q.id}/run`, viewer, {
          params: { element: keyToId['dp-client'], asOf },
        });
      const before = (await run('2027-01-01')).body.rows.find((r: any) => r.role === 'MASTER');
      const after = (await run('2027-08-01')).body.rows.find((r: any) => r.role === 'MASTER');
      expect(before.store).toBe('Legacy Client Database');
      expect(after.store).toBe('Client MDM Hub');
    });

    it('rejects bad parameters and logs runs', async () => {
      const q = await bySlug('process-crud-matrix');
      const bad = await h.call('POST', `/v1/workspaces/${ws()}/catalog/${q.id}/run`, viewer, { params: { element: 'nope', x: 1 } });
      expect(bad.status).toBe(422);
      expect(bad.body.issues).toEqual(expect.arrayContaining(["unknown parameter 'x'", "parameter 'element' must be an element id"]));
      const log = (await h.call('GET', `/v1/catalog/${q.id}/executions`, steward)).body;
      expect(log[0]).toMatchObject({ status: 'ok', version: 1 });
    });

    it('refuses users without a grant', async () => {
      const q = await bySlug('process-crud-matrix');
      await h.call('PUT', `/v1/catalog/${q.id}/grants`, steward, [{ principalType: 'role', principal: 'architect' }]);
      const res = await h.call('POST', `/v1/workspaces/${ws()}/catalog/${q.id}/run`, viewer, {
        params: { element: keyToId['bp-onboarding'] },
      });
      expect(res.status).toBe(404);
      await h.call('PUT', `/v1/catalog/${q.id}/grants`, steward, [{ principalType: 'role', principal: 'viewer' }]);
    });

    it('refuses to run a version whose stored content was tampered with', async () => {
      const q = await bySlug('orphan-elements');
      // Simulate tampering below the API: alter the fingerprint (content itself is frozen by trigger).
      const pool = h.db.pool;
      await pool.query('alter table query_versions disable trigger query_versions_guard');
      await pool.query(`update query_versions set content_hash = 'sha256:forged' where query_id = $1`, [q.id]);
      await pool.query('alter table query_versions enable trigger query_versions_guard');
      const res = await h.call('POST', `/v1/workspaces/${ws()}/catalog/${q.id}/run`, viewer, {});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/fingerprint/);
    });
  });

  describe('authoring and review', () => {
    let id: string;
    const GOOD = `MATCH (a:Application) WHERE a.workspaceId = $workspace AND a.deleted = false
                  AND ($criticality IS NULL OR a.criticality = $criticality)
                  RETURN a.name AS name, a.criticality AS criticality ORDER BY name LIMIT 50`;
    const PARAMS = [{ name: 'criticality', type: 'enum', values: ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'] }];

    it('only authors can create and draft', async () => {
      expect((await h.call('POST', '/v1/catalog', viewer, { slug: 'apps', title: 'Apps' })).status).toBe(403);
      const created = await h.call('POST', '/v1/catalog', author, { slug: 'apps-by-criticality', title: 'Applications by criticality', tags: ['technology'] });
      expect(created.status).toBe(201);
      id = created.body.id;
    });

    it('records check results on drafts, including refused writes', async () => {
      const bad = await h.call('PUT', `/v1/catalog/${id}/draft`, author, {
        cypher: 'MATCH (a:Application) SET a.x = 1 RETURN a',
        params: [],
      });
      expect(bad.status).toBe(200);
      expect(bad.body.checks.errors).toEqual(
        expect.arrayContaining([expect.stringMatching(/SET is not allowed/), expect.stringMatching(/\$workspace/)]),
      );
      expect((await h.call('POST', `/v1/catalog/${id}/submit`, author)).status).toBe(422);

      const good = await h.call('PUT', `/v1/catalog/${id}/draft`, author, { cypher: GOOD, params: PARAMS });
      expect(good.body.checks).toEqual({ errors: [], warnings: [] });
      expect(good.body.version.version).toBe(1);
    });

    it('is invisible to viewers until published and granted', async () => {
      const list = (await h.call('GET', '/v1/catalog', viewer)).body.map((q: any) => q.slug);
      expect(list).not.toContain('apps-by-criticality');
      expect((await h.call('POST', `/v1/workspaces/${ws()}/catalog/${id}/run`, viewer, {})).status).toBe(404);
    });

    it('submits, refuses self-review, and publishes on steward approval', async () => {
      const submitted = await h.call('POST', `/v1/catalog/${id}/submit`, author);
      expect(submitted.body.status).toBe('in_review');

      const selfReviewer = await h.sign('author-c', ['query-author', 'query-steward']);
      expect((await h.call('POST', `/v1/catalog/${id}/review`, selfReviewer, { decision: 'publish' })).status).toBe(403);

      const rejected = await h.call('POST', `/v1/catalog/${id}/review`, steward, { decision: 'reject', note: 'add a tag' });
      expect(rejected.body).toMatchObject({ status: 'draft', reviewNote: 'add a tag' });
      await h.call('POST', `/v1/catalog/${id}/submit`, author);
      const published = await h.call('POST', `/v1/catalog/${id}/review`, steward, { decision: 'publish', note: 'ok' });
      expect(published.body.status).toBe('published');
    });

    it('runs once granted, with enum parameters', async () => {
      await h.call('PUT', `/v1/catalog/${id}/grants`, steward, [{ principalType: 'role', principal: 'viewer' }]);
      const res = await h.call('POST', `/v1/workspaces/${ws()}/catalog/${id}/run`, viewer, { params: { criticality: 'MISSION_CRITICAL' } });
      expect(res.status).toBe(200);
      expect(res.body.rows.map((r: any) => r.name)).toEqual(['Core Banking System', 'Credit Risk Engine']);
    });

    it('keeps published content frozen; changes need a new version', async () => {
      const next = await h.call('PUT', `/v1/catalog/${id}/draft`, author, { cypher: `${GOOD} `, params: PARAMS });
      expect(next.body.version.version).toBe(2);
      const d = (await h.call('GET', `/v1/catalog/${id}`, steward)).body;
      expect(d.versions.map((v: any) => `${v.version}:${v.status}`)).toEqual(['2:draft', '1:published']);
    });

    it('steward can deprecate; invalid moves are refused', async () => {
      expect((await h.call('POST', `/v1/catalog/${id}/versions/1/status`, steward, { status: 'deprecated' })).body.status).toBe('deprecated');
      expect((await h.call('POST', `/v1/catalog/${id}/versions/1/status`, author, { status: 'retired' })).status).toBe(403);
      expect((await h.call('POST', `/v1/catalog/${id}/versions/2/status`, steward, { status: 'published' })).status).toBe(409);
    });

    it('validates grants', async () => {
      const res = await h.call('PUT', `/v1/catalog/${id}/grants`, steward, [{ principalType: 'role', principal: 'superuser' }]);
      expect(res.status).toBe(422);
    });

    it('protects system queries from tenant edits', async () => {
      const q = await bySlug('lifecycle-risk');
      expect((await h.call('PUT', `/v1/catalog/${q.id}/draft`, author, { cypher: GOOD })).status).toBe(409);
    });
  });
});
