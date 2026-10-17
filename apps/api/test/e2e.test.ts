import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import neo4j from 'neo4j-driver';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { parseModelDocument } from '@d4/codecs';
import { applySchema } from '@d4/cypher';
import { createDb, RoleStore, runMigrations, seedLocal, type DbHandle } from '@d4/db';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { JWKS } from '../src/auth/identity';
import { APP_CONFIG, loadConfig } from '../src/config';

const PG = process.env.D4_TEST_POSTGRES_URL;
const NEO = process.env.D4_TEST_NEO4J_URL;
const NEO_PASSWORD = process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev';
const ISSUER = 'http://issuer.test/realms/d4';

describe.skipIf(!PG || !NEO)('API end to end', () => {
  const dbName = `d4_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let handle: DbHandle;
  let app: NestFastifyApplication;
  let workspaceId: string;
  let sign: (sub: string, roles: string[], tenant?: string) => Promise<string>;

  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token?: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined && { payload: payload as object }),
    });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : undefined };
  };
  const gql = async (token: string | undefined, query: string, variables?: object) =>
    call('POST', '/graphql', token, { query, variables });

  beforeAll(async () => {
    // Fresh control-plane database, migrated and seeded (tenant t_local + default workspace).
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    handle = createDb(url.toString(), 2);
    await runMigrations(handle.db);
    ({ workspaceId } = await seedLocal(handle.db));

    // Graph schema (idempotent) so full-text search works on a fresh Neo4j too.
    const driver = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', NEO_PASSWORD));
    const s = driver.session();
    await applySchema(s, new MetamodelRegistry(loadStarterMetamodel()));
    await s.run('CALL db.awaitIndexes(120)');
    await s.close();
    await driver.close();

    // Tokens signed by a local key instead of Keycloak.
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
    sign = (sub, roles, tenant = 't_local') =>
      new SignJWT({ tenant, realm_access: { roles }, email: `${sub}@example.test` })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(ISSUER)
        .setAudience('d4-api')
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

    const config = loadConfig({
      POSTGRES_URL: url.toString(),
      NEO4J_PASSWORD: NEO_PASSWORD,
      NEO4J_URI: NEO,
      OIDC_ISSUER: ISSUER,
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    if (workspaceId && NEO) {
      const driver = neo4j.driver(NEO, neo4j.auth.basic('neo4j', NEO_PASSWORD));
      await driver.executeQuery('MATCH (n:Element) WHERE n.workspaceId = $ws DETACH DELETE n', {
        ws: workspaceId,
      });
      await driver.close();
    }
    await handle?.close();
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const ws = () => `/v1/workspaces/${workspaceId}`;

  describe('authentication and access', () => {
    it('requires a token except for health and the OpenAPI document', async () => {
      expect((await call('GET', '/v1/workspaces')).status).toBe(401);
      expect((await call('GET', '/v1/workspaces', 'not-a-jwt')).status).toBe(401);
      const doc = await call('GET', '/v1/openapi.json');
      expect(doc.status).toBe(200);
      expect(Object.keys(doc.body!['paths'])).toContain('/v1/workspaces/{ws}/elements');
    });

    it('rejects tokens for unknown tenants', async () => {
      const res = await call('GET', '/v1/workspaces', await sign('stranger', ['admin'], 't_unknown'));
      expect(res.status).toBe(403);
    });

    it('lets viewers read but not write', async () => {
      const viewer = await sign('viewer-1', ['viewer']);
      const list = await call('GET', '/v1/workspaces', viewer);
      expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'default' })]));
      expect((await call('GET', `${ws()}/metamodel`, viewer)).body!['id']).toBe('d4-starter');
      const write = await call('POST', `${ws()}/elements`, viewer, { type: 'Platform', attrs: { name: 'x' } });
      expect(write.status).toBe(403);
    });

    it('honours workspace-scoped role bindings', async () => {
      const token = await sign('bound-1', []);
      expect((await call('GET', `${ws()}/elements`, token)).status).toBe(403);
      const me = await call('GET', '/v1/me', token);
      await new RoleStore(handle.db).grant(
        't_local',
        { principalType: 'user', principalId: me.body!['userId'], role: 'contributor', workspaceId },
        'test',
      );
      expect((await call('GET', `${ws()}/elements`, token)).status).toBe(200);
      const created = await call('POST', `${ws()}/elements`, token, { type: 'Platform', attrs: { name: 'Bound' } });
      expect(created.status).toBe(201);
    });

    it('hides other workspaces behind 404', async () => {
      const admin = await sign('admin-1', ['admin']);
      expect((await call('GET', '/v1/workspaces/does-not-exist/elements', admin)).status).toBe(404);
    });
  });

  describe('model commands and reads (REST)', () => {
    let token: string;
    let dp: Record<string, any>;
    let master: Record<string, any>;

    beforeAll(async () => {
      token = await sign('architect-1', ['architect']);
    });

    it('creates elements and validates input', async () => {
      const res = await call('POST', `${ws()}/elements`, token, {
        type: 'DataProduct',
        attrs: { name: 'Customer', classification: 'CONFIDENTIAL' },
      });
      expect(res.status).toBe(201);
      dp = res.body!;
      expect(dp).toMatchObject({ type: 'DataProduct', version: 1, attrs: { name: 'Customer', lifecycle: 'IDEA' } });

      const bad = await call('POST', `${ws()}/elements`, token, { type: 'DataProduct', attrs: { classification: 'SECRET' } });
      expect(bad.status).toBe(422);
      expect(bad.body!['issues']).toEqual(expect.arrayContaining(['DataProduct.name is required']));

      const malformed = await call('POST', `${ws()}/elements`, token, { type: 'DataProduct' });
      expect(malformed.status).toBe(400);
      expect(malformed.body!['error']).toBe('BAD_REQUEST');
    });

    it('enforces single master per data product', async () => {
      const mk = async (name: string) =>
        (await call('POST', `${ws()}/elements`, token, { type: 'DataStore', attrs: { name } })).body!;
      const [crm, mdm, lake] = [await mk('CRM DB'), await mk('MDM Hub'), await mk('Lake')];

      const rel = (fromId: string, role: string) =>
        call('POST', `${ws()}/relationships`, token, { type: 'HOLDS', fromId, toId: dp['id'], attrs: { role } });
      const first = await rel(mdm['id'], 'MASTER');
      expect(first.status).toBe(201);
      master = first.body!;

      const second = await rel(crm['id'], 'MASTER');
      expect(second.status).toBe(422);
      expect(second.body).toMatchObject({ error: 'RULE_VIOLATION', ruleId: 'single-master-per-data-product' });
      expect((await rel(lake['id'], 'APPROVED_DISTRIBUTOR')).status).toBe(201);

      const fetched = await call('GET', `${ws()}/relationships/${master['id']}`, token);
      expect(fetched.body).toMatchObject({ type: 'HOLDS', attrs: { role: 'MASTER' } });
    });

    it('updates with optimistic concurrency and lifecycle rules', async () => {
      const ok = await call('PATCH', `${ws()}/elements/${dp['id']}`, token, {
        expectedVersion: 1,
        set: { lifecycle: 'PROPOSED', sla: '99.9%' },
      });
      expect(ok.status).toBe(200);
      expect(ok.body!['version']).toBe(2);

      const stale = await call('PATCH', `${ws()}/elements/${dp['id']}`, token, { expectedVersion: 1, set: { name: 'x' } });
      expect(stale.status).toBe(409);
      const jump = await call('PATCH', `${ws()}/elements/${dp['id']}`, token, {
        expectedVersion: 2,
        set: { lifecycle: 'LIVE' },
      });
      expect(jump.status).toBe(422);
      expect(jump.body!['error']).toBe('INVALID_TRANSITION');
    });

    it('lists, filters and searches', async () => {
      const stores = await call('GET', `${ws()}/elements?type=DataStore&first=2`, token);
      expect(stores.body!['items']).toHaveLength(2);
      expect(stores.body!['hasMore']).toBe(true);
      const found = await call('GET', `${ws()}/elements?q=custom`, token);
      expect(found.body!['items'].map((e: any) => e.attrs.name)).toEqual(['Customer']);
      expect((await call('GET', `${ws()}/elements?type=NotAType`, token)).status).toBe(400);
    });

    it('serves relationships, neighbourhood and history', async () => {
      const conns = await call('GET', `${ws()}/elements/${dp['id']}/relationships?direction=IN&type=HOLDS`, token);
      expect(conns.body!.map((c: any) => c.relationship.attrs.role).sort()).toEqual(['APPROVED_DISTRIBUTOR', 'MASTER']);

      const hood = await call('GET', `${ws()}/elements/${dp['id']}/neighbourhood?depth=1`, token);
      expect(hood.body!['elements'].map((e: any) => e.attrs.name).sort()).toEqual(['Lake', 'MDM Hub']);

      const history = await call('GET', `${ws()}/elements/${dp['id']}/history`, token);
      expect(history.body!.map((e: any) => e.type)).toEqual(['ElementCreated', 'ElementUpdated']);
      expect(history.body![1].data.changes['attrs.lifecycle']).toEqual({ from: 'IDEA', to: 'PROPOSED' });
    });

    it('soft-deletes elements with their relationships', async () => {
      const store = await call('POST', `${ws()}/elements`, token, { type: 'DataStore', attrs: { name: 'Temp' } });
      const rel = await call('POST', `${ws()}/relationships`, token, {
        type: 'HOLDS', fromId: store.body!['id'], toId: dp['id'], attrs: { role: 'REPLICA' },
      });
      const del = await call('DELETE', `${ws()}/elements/${store.body!['id']}?expectedVersion=1`, token);
      expect(del.status).toBe(204);
      expect((await call('GET', `${ws()}/elements/${store.body!['id']}`, token)).status).toBe(404);
      expect((await call('GET', `${ws()}/relationships/${rel.body!['id']}`, token)).status).toBe(404);
      const history = await call('GET', `${ws()}/relationships/${rel.body!['id']}/history`, token);
      expect(history.body!.map((e: any) => e.data.reason)).toEqual([undefined, 'endpoint-deleted']);
    });
  });

  describe('model as code (import / export)', () => {
    const sample = parseModelDocument(
      readFileSync(join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml'), 'utf8'),
    );

    it('dry-runs without writing and needs only read access', async () => {
      const viewer = await sign('viewer-io', ['viewer']);
      const res = await call('POST', `${ws()}/import?dryRun=true`, viewer, sample);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, applied: false, issues: [] });
      expect(res.body!['elements'].created).toBe(sample.elements.length);
      const search = await call('GET', `${ws()}/elements?q=consolidation`, viewer);
      expect(search.body!['items']).toEqual([]);
    });

    it('imports the UBS sample in one go, then re-imports as a no-op', async () => {
      const token = await sign('importer-1', ['architect']);
      const first = await call('POST', `${ws()}/import`, token, sample);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ ok: true, applied: true });
      expect(first.body!['relationships'].created).toBe(sample.relationships.length);

      const again = await call('POST', `${ws()}/import`, token, sample);
      expect(again.body).toMatchObject({ ok: true, applied: false });
      expect(again.body!['elements']).toEqual({ created: 0, updated: 0, unchanged: sample.elements.length });

      // The planned hand-over is visible: legacy is master until mid-2027, the MDM hub after.
      const clientId = first.body!['keyToId']['dp-client'];
      const holds = await call('GET', `${ws()}/elements/${clientId}/relationships?direction=IN&type=HOLDS`, token);
      const masters = holds.body!
        .filter((c: any) => c.relationship.attrs.role === 'MASTER')
        .map((c: any) => `${c.other.attrs.name}:${c.relationship.validFrom ?? '-'}:${c.relationship.validTo ?? '-'}`)
        .sort();
      expect(masters).toEqual(['Client MDM Hub:2027-07-01:-', 'Legacy Client Database:-:2027-07-01']);

      const history = await call('GET', `${ws()}/elements/${clientId}/history`, token);
      expect(history.body![0]).toMatchObject({ type: 'ElementCreated', data: { source: 'import' } });
    });

    it('rejects invalid documents and rule violations without partial writes', async () => {
      const token = await sign('importer-2', ['architect']);
      const malformed = await call('POST', `${ws()}/import`, token, { apiVersion: 'd4/v1', kind: 'Model' });
      expect(malformed.status).toBe(400);

      const clash = await call('POST', `${ws()}/import`, token, {
        apiVersion: 'd4/v1',
        kind: 'Model',
        metadata: { name: 'clash' },
        elements: [
          { key: 'shadow', type: 'DataStore', name: 'Shadow Client Store' },
          { key: 'client', type: 'DataProduct', name: 'Client Master' },
        ],
        relationships: [{ type: 'HOLDS', from: 'shadow', to: 'client', attrs: { role: 'MASTER' } }],
      });
      expect(clash.status).toBe(200);
      expect(clash.body).toMatchObject({ ok: false, applied: false });
      expect(clash.body!['issues'].map((i: any) => i.ruleId)).toContain('single-master-per-data-product');
      const shadow = await call('GET', `${ws()}/elements?q=shadow`, token);
      expect(shadow.body!['items']).toEqual([]);
    });

    it('exports a document that re-imports unchanged', async () => {
      const token = await sign('exporter-1', ['viewer']);
      const exported = await call('GET', `${ws()}/export`, token);
      expect(exported.status).toBe(200);
      expect(exported.body!['metadata']).toMatchObject({ name: 'Default', metamodel: 'd4-starter@0.2.0' });
      expect(exported.body!['elements'].length).toBeGreaterThanOrEqual(sample.elements.length);

      const writer = await sign('importer-3', ['architect']);
      const roundTrip = await call('POST', `${ws()}/import?dryRun=true`, writer, exported.body);
      expect(roundTrip.body).toMatchObject({ ok: true });
      expect(roundTrip.body!['elements'].created + roundTrip.body!['elements'].updated).toBe(0);
      expect(roundTrip.body!['relationships'].created + roundTrip.body!['relationships'].updated).toBe(0);
    });
  });

  describe('GraphQL reads', () => {
    it('requires authentication', async () => {
      const res = await gql(undefined, '{ me { userId } }');
      expect(res.body!['errors'][0].extensions.code).toBe('UNAUTHORIZED');
    });

    it('navigates workspace → elements → connections', async () => {
      const token = await sign('analyst-1', ['viewer']);
      const res = await gql(
        token,
        `query ($ws: ID!) {
           me { roles }
           workspace(id: $ws) {
             slug
             metamodel { version nodeTypes { name labels } }
             elements(filter: { types: ["DataProduct"] }) {
               nodes {
                 name lifecycle
                 connections(direction: IN, types: ["HOLDS"]) {
                   direction
                   relationship { attrs from { name } }
                 }
               }
             }
           }
         }`,
        { ws: workspaceId },
      );
      expect(res.body!['errors']).toBeUndefined();
      const w = res.body!['data'].workspace;
      expect(w.slug).toBe('default');
      expect(w.metamodel.nodeTypes.find((t: any) => t.name === 'Division').labels).toContain('OrgUnit');
      const customer = w.elements.nodes.find((n: any) => n.name === 'Customer');
      expect(customer.lifecycle).toBe('PROPOSED');
      expect(
        customer.connections.map((c: any) => `${c.direction}:${c.relationship.attrs.role}:${c.relationship.from.name}`).sort(),
      ).toEqual(['IN:APPROVED_DISTRIBUTOR:Lake', 'IN:MASTER:MDM Hub']);
    });

    it('maps domain and access errors to codes', async () => {
      const token = await sign('analyst-2', ['viewer']);
      const unknown = await gql(token, 'query ($ws: ID!) { workspace(id: $ws) { elements(filter: { types: ["Nope"] }) { nodes { id } } } }', {
        ws: workspaceId,
      });
      expect(unknown.body!['errors'][0].extensions.code).toBe('BAD_REQUEST');
      const missing = await gql(token, '{ workspace(id: "nope") { id } }');
      expect(missing.body!['errors'][0].extensions.code).toBe('NOT_FOUND');
    });
  });
});
