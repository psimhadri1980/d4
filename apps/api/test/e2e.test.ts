import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import neo4j from 'neo4j-driver';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { parseModelDocument } from '@d4/codecs';
import { allElements, createClient, D4ApiError } from '@d4/sdk';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { JobQueue, processJob, S3ArtifactStore, startJobWorker } from '@d4/jobs';
import { createDb, LOCAL_TENANT, MetamodelStore, RoleStore, runMigrations, schema, seedLocal, TenantStore, UsageStore, WorkspaceStore, type DbHandle } from '@d4/db';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { JWKS } from '../src/auth/identity';
import { APP_CONFIG, loadConfig } from '../src/config';
import { Database } from '../src/infra/database.service';
import { TenantGraphService } from '../src/infra/tenant-graph.service';

const PG = process.env.D4_TEST_POSTGRES_URL;
const NEO = process.env.D4_TEST_NEO4J_URL;
const NEO_PASSWORD = process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev';
const ISSUER = 'http://issuer.test/realms/d4';
const REDIS = process.env.D4_TEST_REDIS_URL;
const S3 = process.env.D4_TEST_S3_ENDPOINT;

describe.skipIf(!PG || !NEO)('API end to end', () => {
  const dbName = `d4_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let handle: DbHandle;
  let app: NestFastifyApplication;
  let workspaceId: string;
  let sampleIds: Record<string, string> = {};
  let jobQueueName = '';
  let jobWorker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
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
    await awaitSchemaOnline(s);
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
      D4_ENV: 'dev',
      POSTGRES_URL: url.toString(),
      NEO4J_PASSWORD: NEO_PASSWORD,
      NEO4J_URI: NEO,
      OIDC_ISSUER: ISSUER,
      // Jobs: a queue of our own, so a running dev worker does not take these jobs.
      REDIS_URL: REDIS ?? '',
      S3_ENDPOINT: S3 ?? '',
      S3_ACCESS_KEY: 'd4',
      S3_SECRET_KEY: 'd4-local-dev',
      S3_BUCKET: 'd4-test-artifacts',
      JOB_QUEUE: `d4-jobs-e2e-${dbName}`,
    });
    jobQueueName = config.JOB_QUEUE!;
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
    await jobWorker?.close();
    if (REDIS && jobQueueName) {
      const q = new JobQueue(REDIS, jobQueueName);
      await q.obliterate();
      await q.close();
    }
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

    it('validates roadmap requests', async () => {
      const token = await sign('planner-0', ['viewer']);
      expect((await call('GET', `${ws()}/roadmap`, token)).status).toBe(400);
      expect((await call('GET', `${ws()}/roadmap?scope=x&lanes=bogus`, token)).status).toBe(400);
    });

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
      sampleIds = first.body!['keyToId'];

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

    it('builds a roadmap over REST, with lanes and conflicts', async () => {
      const token = await sign('planner-1', ['viewer']);
      const res = await call('GET', `${ws()}/roadmap?scope=${sampleIds['ds-legacy-client']}&lanes=status&today=2026-10-18`, token);
      expect(res.status).toBe(200);
      const names = (ids: string[]) => ids.map((id) => res.body!['items'].find((i: any) => i.id === id).name);
      expect(names(res.body!['criticalPath'])).toEqual(['Client master cut-over', 'Decommission legacy client database']);
      expect(res.body!['lanes'].map((l: any) => l.name).sort()).toEqual(['Milestones', 'NOT_STARTED']);
      expect(res.body!['changes'].map((c: any) => c.action)).toEqual(['RETIRE', 'RETIRE']);
      const empty = await call('GET', `${ws()}/roadmap?scope=nope`, token);
      expect(empty.body).toMatchObject({ items: [], conflicts: [], start: null });
    });

    it('reads the model as of a date and compares two dates', async () => {
      const token = await sign('planner-2', ['viewer']);
      const client = sampleIds['dp-client'];
      const holders = async (asOf: string) =>
        (await call('GET', `${ws()}/elements/${client}/relationships?direction=IN&type=HOLDS&asOf=${asOf}`, token)).body!
          .map((c: any) => `${c.other.attrs.name}:${c.relationship.attrs.role}`)
          .sort();
      const undated = ['Group Data Lake:APPROVED_DISTRIBUTOR', 'Wealth CRM Store:CONSUMER_CACHE'];
      expect(await holders('2027-01-01')).toEqual(['Client MDM Hub:GOLDEN_COPY', ...undated, 'Legacy Client Database:MASTER'].sort());
      expect(await holders('2027-08-01')).toEqual(['Client MDM Hub:MASTER', ...undated, 'Legacy Client Database:REPLICA'].sort());

      const diff = await call('GET', `${ws()}/diff?fromAsOf=2027-01-01&toAsOf=2027-08-01`, token);
      expect(diff.status).toBe(200);
      const changed = diff.body!['relationships'].changed.map(
        (c: any) => `${diff.body!['names'][c.before.fromId]}:${c.before.attrs.role}→${c.after.attrs.role}`,
      );
      expect(changed.sort()).toEqual(['Client MDM Hub:GOLDEN_COPY→MASTER', 'Legacy Client Database:MASTER→REPLICA']);

      expect((await call('GET', `${ws()}/diff?fromAsOf=2027-01-01&toAsOf=2027-01-01`, token)).status).toBe(400);
      expect((await call('GET', `${ws()}/diff?toScenario=nope`, token)).status).toBe(404);
      const notScenario = await call('GET', `${ws()}/diff?toScenario=${client}`, token);
      expect(notScenario.body).toMatchObject({ error: 'VALIDATION', message: expect.stringContaining('not a Scenario') });
    });

    it('overlays a scenario that brings the hand-over forward', async () => {
      const architect = await sign('planner-3', ['architect']);
      const viewer = await sign('planner-4', ['viewer']);
      const scenario = await call('POST', `${ws()}/elements`, architect, { type: 'Scenario', attrs: { name: 'Early cut-over' } });
      const sid = scenario.body!['id'];
      const holds = (from: string, role: string, p: object) =>
        call('POST', `${ws()}/relationships`, architect, {
          type: 'HOLDS', fromId: sampleIds[from], toId: sampleIds['dp-client'], attrs: { role }, scenarioId: sid, ...p,
        });
      expect((await holds('ds-legacy-client', 'MASTER', { validTo: '2027-04-01' })).status).toBe(201);
      expect((await holds('ds-mdm', 'MASTER', { validFrom: '2027-04-01' })).status).toBe(201);

      const master = async (q: string) =>
        (await call('GET', `${ws()}/elements/${sampleIds['dp-client']}/relationships?direction=IN&type=HOLDS&${q}`, viewer)).body!
          .filter((c: any) => c.relationship.attrs.role === 'MASTER')
          .map((c: any) => c.other.attrs.name);
      expect(await master('asOf=2027-05-01')).toEqual(['Legacy Client Database']);
      expect(await master(`asOf=2027-05-01&scenario=${sid}`)).toEqual(['Client MDM Hub']);

      const res = await gql(
        viewer,
        `query ($ws: ID!, $s: ID!) {
           workspace(id: $ws) {
             diff(from: { asOf: "2027-05-01" }, to: { asOf: "2027-05-01", scenario: $s }) {
               names
               relationships { added { fromId attrs } removed { fromId attrs } changed { fields } }
             }
           }
         }`,
        { ws: workspaceId, s: sid },
      );
      expect(res.body!['errors']).toBeUndefined();
      const d = res.body!['data'].workspace.diff;
      const rows = (list: any[]) => list.map((r) => `${d.names[r.fromId]}:${r.attrs.role}`).sort();
      // Legacy's master has already ended in the scenario; MDM's GOLDEN_COPY becomes MASTER.
      expect(rows(d.relationships.added)).toEqual([]);
      expect(rows(d.relationships.removed)).toEqual(['Legacy Client Database:MASTER']);
      expect(d.relationships.changed.map((c: any) => c.fields.find((f: any) => f.field === 'role'))).toEqual([
        { field: 'role', before: 'GOLDEN_COPY', after: 'MASTER' },
      ]);
    });

    it('serves matrices and the decision log', async () => {
      const token = await sign('analyst-4', ['viewer']);
      const crud = await call('GET', `${ws()}/matrix/crud`, token);
      expect(crud.status).toBe(200);
      const step = crud.body!['rows'].find((r: any) => r.name === 'Capture client details');
      const client = crud.body!['columns'].find((c: any) => c.name === 'Client Master');
      expect(crud.body!['cells']).toContainEqual({ row: step.id, column: client.id, values: ['CREATE'] });

      const roles = await call('GET', `${ws()}/matrix/data-store-roles?asOf=2027-08-01`, token);
      const mdm = roles.body!['rows'].find((r: any) => r.name === 'Client MDM Hub');
      expect(roles.body!['cells']).toContainEqual({ row: mdm.id, column: client.id, values: ['MASTER'] });

      const heat = await call('GET', `${ws()}/matrix/lifecycle`, token);
      expect(heat.body!['columns'].map((c: any) => c.name)).toContain('LIVE');
      expect((await call('GET', `${ws()}/matrix/nope`, token)).status).toBe(400);

      const log = await call('GET', `${ws()}/decisions`, token);
      expect(log.body![0]).toMatchObject({ name: 'Client MDM Hub becomes master for client data', status: 'ACCEPTED', findings: [] });

      const g = await gql(token, `query ($ws: ID!) { workspace(id: $ws) { matrix(kind: "capability-application") { title rows { name } findings } decisions { name options { name chosen } } } }`, {
        ws: workspaceId,
      });
      expect(g.body!['errors']).toBeUndefined();
      expect(g.body!['data'].workspace.matrix.title).toBe('Capability × application');
      expect(g.body!['data'].workspace.decisions[0].options.find((o: any) => o.chosen).name).toBe('Introduce a dedicated client MDM hub');
    });

    it('exports in other formats, for a scope and a view', async () => {
      const token = await sign('exporter-1', ['viewer']);
      const raw = async (q: string) => {
        const res = await app.inject({ method: 'GET', url: `${ws()}/export?${q}`, headers: { authorization: `Bearer ${token}` } });
        return { status: res.statusCode, type: String(res.headers['content-type']), disposition: String(res.headers['content-disposition']), body: res.body };
      };
      const mermaid = await raw('format=mermaid');
      expect(mermaid).toMatchObject({ status: 200, type: 'text/plain; charset=utf-8' });
      expect(mermaid.disposition).toMatch(/attachment; filename="default\.mmd"/);
      expect(mermaid.body).toMatch(/^---\ntitle: /);

      const archi = await raw('format=archimate');
      expect(archi.type).toContain('application/xml');
      expect(archi.body).toContain('xsi:type="ApplicationComponent"');

      // Scoped to Client Master's neighbourhood on a date: only the master valid then.
      const csv = await raw(`format=relationships-csv&scope=${sampleIds['dp-client']}&asOf=2027-08-01`);
      expect(csv.disposition).toContain('default-2027-08-01.relationships.csv');
      const holds = csv.body.split('\n').filter((l) => l.includes(',HOLDS,') && l.includes(',MASTER'));
      expect(holds).toHaveLength(1);
      expect(holds[0]).toContain('Client MDM Hub');

      const yaml = await raw('format=yaml');
      expect(yaml.body).toMatch(/^apiVersion: d4\/v1/);
      expect((await raw('format=pdf')).status).toBe(400);
    });

    it('imports CSV and Excel via analyze → dry run → apply, and round-trips its own Excel export', async () => {
      const architect = await sign('sheets-1', ['architect']);
      const viewer = await sign('sheets-2', ['viewer']);
      const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
      const apps = { name: 'Applications.csv', content: b64('Name,Criticality,timeClass\nSheet Gateway,high,invest\nSheet Broken,huge,\n') };
      const links = { name: 'links.csv', content: b64('type,from,to\nREALIZES,Sheet Gateway,Capability: Client Onboarding\n') };

      const analyzed = await call('POST', `${ws()}/import/tabular/analyze`, viewer, { files: [apps, links] });
      expect(analyzed.status).toBe(200);
      expect(analyzed.body!['tables'].map((t: any) => [t.name, t.rowCount, t.mapping.kind, t.mapping.type ?? null])).toEqual([
        ['Applications.csv', 2, 'elements', 'Application'],
        ['links.csv', 1, 'relationships', null],
      ]);

      // A bad row blocks the whole import and is reported with row and column.
      const dry = await call('POST', `${ws()}/import/tabular?dryRun=true`, viewer, { files: [apps, links] });
      expect(dry.body).toMatchObject({ ok: false, applied: false, rowIssues: [{ table: 'Applications.csv', row: 3, column: 'Criticality' }] });

      // Ignore the bad row's column via the mapping; viewers may dry-run but not apply.
      const mappings = [{ table: 'Applications.csv', mapping: { kind: 'elements', type: 'Application', columns: { Name: 'name', Criticality: 'ignore', timeClass: 'attr:timeClass' } } }];
      expect((await call('POST', `${ws()}/import/tabular`, viewer, { files: [apps, links], mappings })).status).toBe(403);
      const applied = await call('POST', `${ws()}/import/tabular`, architect, { files: [apps, links], mappings });
      expect(applied.body).toMatchObject({ ok: true, applied: true, rowIssues: [], elements: { created: 2 }, relationships: { created: 1 } });
      const again = await call('POST', `${ws()}/import/tabular`, architect, { files: [apps, links], mappings });
      expect(again.body).toMatchObject({ ok: true, applied: false, elements: { created: 0, unchanged: 2 } });

      // The workspace's own Excel export imports back with no changes.
      const xlsx = await app.inject({ method: 'GET', url: `${ws()}/export?format=xlsx`, headers: { authorization: `Bearer ${architect}` } });
      expect(xlsx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const round = await call('POST', `${ws()}/import/tabular?dryRun=true`, viewer, { files: [{ name: 'default.xlsx', content: xlsx.rawPayload.toString('base64') }] });
      expect(round.body).toMatchObject({ ok: true, rowIssues: [], elements: { created: 0, updated: 0 }, relationships: { created: 0, updated: 0 } });

      expect((await call('POST', `${ws()}/import/tabular/analyze`, viewer, { files: [{ name: 'x.pdf', content: b64('%PDF') }] })).body).toMatchObject({
        error: 'VALIDATION',
        message: 'x.pdf: only .csv and .xlsx files can be imported',
      });
    });

    it.skipIf(!REDIS || !S3)('runs exports and imports as background jobs', async () => {
      // A worker in this process, on this test's queue, with the API's own connections.
      jobWorker = startJobWorker(REDIS!, (msg, attempt) =>
        processJob(msg, {
          db: app.get(Database).db,
          graphs: app.get(TenantGraphService).graphs,
          artifacts: new S3ArtifactStore({ endpoint: S3!, accessKey: 'd4', secretKey: 'd4-local-dev', bucket: 'd4-test-artifacts' }),
        }, attempt),
        { queue: jobQueueName },
      );
      const viewer = await sign('jobs-1', ['viewer']);
      const other = await sign('jobs-2', ['viewer']);
      const architect = await sign('jobs-3', ['architect']);
      const waitFor = async (token: string, id: string) => {
        for (let i = 0; i < 100; i++) {
          const j = (await call('GET', `${ws()}/jobs/${id}`, token)).body!;
          if (j['status'] === 'succeeded' || j['status'] === 'failed') return j;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`job ${id} did not finish`);
      };

      const created = await call('POST', `${ws()}/jobs/export`, viewer, { format: 'archimate', asOf: '2027-08-01' });
      expect(created.status).toBe(202);
      expect(created.body).toMatchObject({ kind: 'export', status: 'queued', params: { format: 'archimate', asOf: '2027-08-01' }, artifact: null });
      const done = await waitFor(viewer, created.body!['id']);
      expect(done).toMatchObject({ status: 'succeeded', progress: 100, artifact: { name: 'default-2027-08-01.archimate.xml' } });

      const file = await app.inject({ method: 'GET', url: `${ws()}/jobs/${done['id']}/artifact`, headers: { authorization: `Bearer ${viewer}` } });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toContain('default-2027-08-01.archimate.xml');
      expect(file.body).toContain('xsi:type="ApplicationComponent"');

      // Jobs are private to whoever started them.
      expect((await call('GET', `${ws()}/jobs/${done['id']}`, other)).status).toBe(403);
      expect((await call('GET', `${ws()}/jobs`, other)).body).toEqual([]);
      expect((await call('GET', `${ws()}/jobs`, viewer)).body!.map((j: any) => j.id)).toEqual([done['id']]);
      expect((await call('POST', `${ws()}/jobs/export`, viewer, { scenario: 'nope' })).status).toBe(404);

      // Imports: applying needs write access at submission; the job then runs as that user.
      const files = [{ name: 'Platforms.csv', content: Buffer.from('Name,platformType\nQueued Kafka,streaming\n').toString('base64') }];
      expect((await call('POST', `${ws()}/jobs/import-tabular`, viewer, { files })).status).toBe(403);
      const imp = await call('POST', `${ws()}/jobs/import-tabular`, architect, { files });
      const imported = await waitFor(architect, imp.body!['id']);
      expect(imported).toMatchObject({ status: 'succeeded', params: { dryRun: false, files: ['Platforms.csv'] }, result: { ok: true, applied: true, elements: { created: 1 } }, artifact: null });
      const found = (await call('GET', `${ws()}/elements?q=queued%20kafka`, viewer)).body!['items'];
      expect(found[0]).toMatchObject({ createdBy: expect.any(String), attrs: { name: 'Queued Kafka' } });
      expect((await call('GET', `${ws()}/jobs/${imp.body!['id']}/artifact`, architect)).status).toBe(404);

      // Renders go to the render queue; validate before queueing.
      expect((await call('POST', `${ws()}/jobs/render`, viewer, { target: 'graph', format: 'png', root: 'nope' })).status).toBe(404);
      expect((await call('POST', `${ws()}/jobs/render`, viewer, { target: 'graph', format: 'gif', root: sampleIds['dp-client'] })).status).toBe(400);
      const render = await call('POST', `${ws()}/jobs/render`, viewer, { target: 'roadmap', format: 'svg', scope: [sampleIds['init-client-data']] });
      expect(render).toMatchObject({ status: 202, body: { kind: 'render', status: 'queued' } });

      // Scheduled reports: create, run now (an export, so this test's worker runs it), manage.
      const sched = await call('POST', `${ws()}/schedules`, viewer, {
        name: 'Weekly model export',
        kind: 'export',
        params: { format: 'mermaid' },
        cadence: { frequency: 'weekly', hour: 7, weekday: 1 },
        recipients: ['Team@Example.test', 'team@example.test'],
      });
      expect(sched).toMatchObject({ status: 201, body: { cadenceText: 'Every Monday at 07:00 UTC', enabled: true, lastJob: null, recipients: ['team@example.test'], pausedReason: null } });
      expect((await call('POST', `${ws()}/schedules`, viewer, { name: 'x', kind: 'export', params: { format: 'yaml' }, cadence: { frequency: 'daily', hour: 1 }, recipients: ['not-an-email'] })).status).toBe(400);
      // Sign-in stores realm roles, so scheduled runs can re-check the owner's access later.
      const me = (await call('GET', '/v1/me', viewer)).body!;
      const owner = (await handle.db.select().from(schema.users)).find((u) => u.id === me['userId']);
      expect(owner!.realmRoles).toEqual(['viewer']);
      expect(new Date(sched.body!['nextRunAt']).getUTCDay()).toBe(1);
      const runNow = await call('POST', `${ws()}/schedules/${sched.body!['id']}/run`, viewer);
      expect(runNow.body).toMatchObject({ kind: 'export', scheduleId: sched.body!['id'], params: { format: 'mermaid', asOf: new Date().toISOString().slice(0, 10) } });
      await waitFor(viewer, runNow.body!['id']);
      const listed = (await call('GET', `${ws()}/schedules`, viewer)).body!;
      expect(listed).toEqual([expect.objectContaining({ id: sched.body!['id'], lastJob: expect.objectContaining({ status: 'succeeded', artifact: expect.objectContaining({ name: expect.stringMatching(/\.mmd$/) }) }) })]);

      expect((await call('PATCH', `${ws()}/schedules/${sched.body!['id']}`, other, { enabled: false })).status).toBe(403);
      const paused = await call('PATCH', `${ws()}/schedules/${sched.body!['id']}`, viewer, { enabled: false });
      expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null });
      expect((await call('POST', `${ws()}/schedules`, viewer, { name: 'x', kind: 'render', params: { target: 'graph', format: 'png', root: 'nope' }, cadence: { frequency: 'daily', hour: 1 } })).status).toBe(404);
      expect((await call('POST', `${ws()}/schedules`, viewer, { name: 'x', kind: 'export', params: { format: 'pdf' }, cadence: { frequency: 'daily', hour: 1 } })).body).toMatchObject({ error: 'VALIDATION' });
      expect((await call('DELETE', `${ws()}/schedules/${sched.body!['id']}`, viewer)).status).toBe(204);
      expect((await call('GET', `${ws()}/schedules`, viewer)).body).toEqual([]);
    });

    it('lets admins manage workspaces and members, and nobody else', async () => {
      const admin = await sign('tenant-admin', ['admin']);
      const viewer = await sign('plain-viewer', ['viewer']);
      expect((await call('GET', '/v1/admin/workspaces', viewer)).status).toBe(403);

      const created = await call('POST', '/v1/admin/workspaces', admin, { slug: 'Retail-Lab', name: 'Retail lab' });
      expect(created).toMatchObject({ status: 201, body: { slug: 'retail-lab', archived: false } });
      expect((await call('POST', '/v1/admin/workspaces', admin, { slug: 'retail-lab', name: 'Again' })).status).toBe(409);
      expect((await call('POST', '/v1/admin/workspaces', admin, { slug: 'Bad slug!', name: 'x' })).status).toBe(400);
      const id = created.body!['id'];

      // A viewer with no binding cannot see the new workspace's data until granted.
      const me = (await call('GET', '/v1/me', viewer)).body!;
      expect((await call('GET', `/v1/workspaces/${id}/elements`, await sign('outsider', []))).status).toBe(403);
      expect((await call('POST', `/v1/admin/members/${id}`, admin, { principalId: me['userId'], role: 'planner' })).status).toBe(204);
      expect((await call('GET', `/v1/admin/members/${id}`, admin)).body).toEqual([
        expect.objectContaining({ principalType: 'user', principalId: me['userId'], role: 'planner', label: 'plain-viewer@example.test' }),
      ]);
      expect((await call('POST', `/v1/admin/members/${id}`, admin, { principalId: 'ghost', role: 'viewer' })).status).toBe(404);

      // Tenant-wide admin cannot be removed from oneself.
      const adminMe = (await call('GET', '/v1/me', admin)).body!;
      await call('POST', '/v1/admin/members/tenant', admin, { principalId: adminMe['userId'], role: 'admin' });
      expect((await call('DELETE', '/v1/admin/members/tenant', admin, { principalId: adminMe['userId'], role: 'admin' })).status).toBe(409);
      expect((await call('DELETE', `/v1/admin/members/${id}`, admin, { principalId: me['userId'], role: 'planner' })).status).toBe(204);
      expect((await call('GET', `/v1/admin/members/${id}`, admin)).body).toEqual([]);

      expect((await call('PATCH', `/v1/admin/workspaces/${id}`, admin, { name: 'Retail lab (old)' })).body).toMatchObject({ name: 'Retail lab (old)' });
      expect((await call('POST', `/v1/admin/workspaces/${id}/archive`, admin)).status).toBe(204);
      expect((await call('GET', '/v1/workspaces', admin)).body!.map((w: any) => w.id)).not.toContain(id);
      expect((await call('GET', '/v1/admin/workspaces?archived=true', admin)).body!.find((w: any) => w.id === id)).toMatchObject({ archived: true });
      expect((await call('GET', `/v1/workspaces/${id}/elements`, admin)).status).toBe(404);
      expect((await call('POST', `/v1/admin/workspaces/${id}/restore`, admin)).status).toBe(204);
      expect((await call('GET', `/v1/workspaces/${id}/elements`, admin)).status).toBe(200);
    });

    it('creates workspaces on industry metamodel packs, with their types and indexes ready', async () => {
      const admin = await sign('tenant-admin', ['admin']);
      expect((await call('GET', '/v1/admin/metamodel-packs', admin)).body!.map((p: any) => p.id)).toEqual(['d4-starter', 'd4-banking', 'd4-insurance']);
      expect((await call('POST', '/v1/admin/workspaces', admin, { slug: 'x-pack', name: 'x', metamodel: 'd4-unknown' })).status).toBe(400);
      const created = await call('POST', '/v1/admin/workspaces', admin, { slug: 'bank-lab', name: 'Bank lab', metamodel: 'd4-banking' });
      expect(created).toMatchObject({ status: 201, body: { metamodel: 'd4-banking@0.1.0' } });
      const bank = `/v1/workspaces/${created.body!['id']}`;

      const report = (await call('POST', `${bank}/elements`, admin, { type: 'RegulatoryReport', attrs: { name: 'COREP own funds', regime: 'BASEL_III', frequency: 'QUARTERLY', templateCode: 'C 01.00' } })).body!;
      const product = (await call('POST', `${bank}/elements`, admin, { type: 'DataProduct', attrs: { name: 'Capital positions' } })).body!;
      const rel = await call('POST', `${bank}/relationships`, admin, { type: 'SOURCED_FROM', fromId: report['id'], toId: product['id'], attrs: { lineageVerified: true } });
      expect(rel.status).toBe(201);
      // Reading a relationship by id uses the pack's own relationship-id index.
      expect((await call('GET', `${bank}/relationships/${rel.body!['id']}`, admin)).body).toMatchObject({ type: 'SOURCED_FROM', attrs: { lineageVerified: true } });
      expect((await call('GET', `${bank}/metamodel`, admin)).body).toMatchObject({ id: 'd4-banking' });
      // Pack types do not exist in a starter workspace, and the starter's own index survived the pack.
      expect((await call('POST', `${ws()}/elements`, admin, { type: 'RegulatoryReport', attrs: { name: 'x' } })).status).toBe(422);
      const store = (await call('POST', `${ws()}/elements`, admin, { type: 'DataStore', attrs: { name: 'Pack-test store' } })).body!;
      const target = (await call('POST', `${ws()}/elements`, admin, { type: 'DataProduct', attrs: { name: 'Pack-test product' } })).body!;
      const holds = (await call('POST', `${ws()}/relationships`, admin, { type: 'HOLDS', fromId: store['id'], toId: target['id'], attrs: { role: 'REPLICA' } })).body!;
      expect((await call('GET', `${ws()}/relationships/${holds['id']}`, admin)).status).toBe(200);
      expect((await call('GET', '/v1/admin/workspaces', admin)).body!.find((w: any) => w.slug === 'bank-lab')).toMatchObject({ metamodel: 'd4-banking@0.1.0' });
    });

    it('lets admins manage connectors: validated config and mapping, write-only secret, sync jobs', async () => {
      const admin = await sign('tenant-admin', ['admin']);
      expect((await call('GET', `${ws()}/connectors`, await sign('plain-viewer', ['viewer']))).status).toBe(403);
      expect((await call('GET', `${ws()}/connectors/kinds`, admin)).body!.map((k: any) => k.kind)).toEqual(['http-json', 'git']);
      // Local repositories are for local development only (this API does not allow private URLs).
      expect((await call('POST', `${ws()}/connectors`, admin, { key: 'repo', name: 'Repo', kind: 'git', config: { url: 'file:///srv/model' } })).body).toMatchObject({ message: 'file:// repositories are only allowed in local development' });
      const base = {
        key: 'cmdb',
        name: 'CMDB',
        kind: 'http-json',
        config: { url: 'https://93.184.215.14/api/now/table/cmdb_ci', auth: 'bearer', nextPath: 'links.next' },
        mapping: { itemsPath: 'result', entities: [{ type: { value: 'Application' }, id: 'sys_id', name: 'name' }] },
        secret: 'token-123',
        cadence: { frequency: 'daily', hour: 3 },
        enabled: false,
      };
      expect((await call('POST', `${ws()}/connectors`, admin, { ...base, kind: 'ftp' })).status).toBe(400);
      expect((await call('POST', `${ws()}/connectors`, admin, { ...base, config: { url: 'https://127.0.0.1/x' } })).body).toMatchObject({ message: 'Source URL must not point to a private or local address' });
      expect((await call('POST', `${ws()}/connectors`, admin, { ...base, mapping: { entities: [] } })).status).toBe(400);
      const created = await call('POST', `${ws()}/connectors`, admin, base);
      expect(created).toMatchObject({ status: 201, body: { key: 'cmdb', hasSecret: true, enabled: false, cadenceText: expect.stringMatching(/03:00 UTC/), config: { auth: 'bearer', maxPages: 50 } } });
      expect(created.body!['secret']).toBeUndefined();
      expect((await call('POST', `${ws()}/connectors`, admin, base)).status).toBe(409);
      const id = created.body!['id'];

      // A turned-off connector refuses to sync (no request leaves the test).
      const job = await call('POST', `${ws()}/connectors/${id}/sync`, admin, { dryRun: true });
      expect(job).toMatchObject({ status: 202, body: { kind: 'sync', params: { connectorId: id, dryRun: true } } });
      await processJob({ tenantId: 't_local', jobId: job.body!['id'] }, { db: app.get(Database).db, graphs: app.get(TenantGraphService).graphs, artifacts: undefined as never });
      expect((await call('GET', `${ws()}/connectors/${id}/runs`, admin)).body).toEqual([expect.objectContaining({ id: job.body!['id'], status: 'failed', error: 'The connector is turned off' })]);

      expect((await call('PATCH', `${ws()}/connectors/${id}`, admin, { secret: null, conflictPolicy: 'source-wins' })).body).toMatchObject({ hasSecret: false, conflictPolicy: 'source-wins' });
      expect((await call('DELETE', `${ws()}/connectors/${id}`, admin)).status).toBe(204);
      expect((await call('GET', `${ws()}/connectors/${id}`, admin)).status).toBe(404);
    });

    it('serves the typed SDK end to end', async () => {
      // The SDK speaks fetch; route it into the in-process app.
      const viaApp = (async (url: string, init: RequestInit = {}) => {
        const u = new URL(url);
        const res = await app.inject({
          method: (init.method ?? 'GET') as 'GET',
          url: `${u.pathname}${u.search}`,
          headers: init.headers as Record<string, string>,
          ...(init.body !== undefined && { payload: String(init.body) }),
        });
        return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: res.headers as Record<string, string> });
      }) as unknown as typeof fetch;
      const d4 = createClient({ baseUrl: 'http://api.test', token: await sign('sdk-user', ['architect']), fetch: viaApp });

      expect((await d4.get('/v1/me')).roles).toContain('architect');
      const wsId = (await d4.get('/v1/workspaces'))[0]!.id;
      const el = await d4.post('/v1/workspaces/{ws}/elements', { path: { ws: wsId }, body: { type: 'DataProduct', attrs: { name: 'SDK product' } } });
      const updated = await d4.patch('/v1/workspaces/{ws}/elements/{id}', { path: { ws: wsId, id: el.id }, body: { expectedVersion: 1, set: { description: 'via SDK' } } });
      expect(updated.version).toBe(2);
      const found: string[] = [];
      for await (const e of allElements(d4, wsId, { q: 'SDK product', first: 1 })) found.push(e.id);
      expect(found).toContain(el.id);
      const stale = await d4.patch('/v1/workspaces/{ws}/elements/{id}', { path: { ws: wsId, id: el.id }, body: { expectedVersion: 1, set: { description: 'stale' } } }).catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(D4ApiError);
      expect(stale).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    });

    it('keeps tenants apart: workspaces, ids and graphs of one tenant are invisible to another', async () => {
      // Tenant B is registered (wrongly) on the same Neo4j as the local tenant.
      const tenants = new TenantStore(handle.db);
      await tenants.ensure({ id: 't_other', slug: 'other', name: 'Other' });
      await tenants.upsertInstance({ tenantId: 't_other', boltUri: 'bolt://neo4j:7687', secretRef: 'env:NEO4J_PASSWORD', neo4jVersion: '5.26', status: 'ready' });
      const mm = new MetamodelStore(handle.db);
      const mmId = await mm.register('t_other', loadStarterMetamodel(), 'test');
      await mm.activate('t_other', mmId);
      const other = await new WorkspaceStore(handle.db).create('t_other', { slug: 'default', name: 'Other default', metamodelId: mmId });

      const a = await sign('tenant-admin', ['admin']);
      const b = await sign('other-admin', ['admin'], 't_other');
      expect((await call('GET', '/v1/workspaces', b)).body!.map((w: any) => w.id)).toEqual([other.id]);
      expect((await call('GET', '/v1/workspaces', a)).body!.map((w: any) => w.id)).not.toContain(other.id);
      // Each tenant's ids are unknown to the other.
      expect((await call('GET', `${ws()}/elements`, b)).status).toBe(404);
      expect((await call('GET', `/v1/workspaces/${other.id}/elements`, a)).status).toBe(404);
      // B's own workspace cannot reach a graph that belongs to A, even though the registry points there.
      const own = await call('GET', `/v1/workspaces/${other.id}/elements`, b);
      expect(own.status).toBe(404);
      expect(own.body!['message']).toMatch(/belongs to another tenant/);
      expect((await call('GET', '/v1/admin/users', b)).body!.map((u: any) => u.email)).not.toContain('tenant-admin@example.test');
    });

    it.skipIf(!REDIS || !S3)('backs up a workspace, verifies it against the event log, and guards restores', async () => {
      const admin = await sign('tenant-admin', ['admin']);
      const architect = await sign('backup-architect', ['architect']);
      const deps = {
        db: app.get(Database).db,
        graphs: app.get(TenantGraphService).graphs,
        artifacts: new S3ArtifactStore({ endpoint: S3!, accessKey: 'd4', secretKey: 'd4-local-dev', bucket: 'd4-test-artifacts' }),
      };
      // The queue worker started by the jobs test runs queued jobs; run alone, there is none, so run them here.
      const runJob = async (res: { body?: Record<string, any> }) => {
        const id = res.body!['id'];
        if (!jobWorker) await processJob({ tenantId: 't_local', jobId: id }, deps);
        for (let i = 0; i < 1500; i++) {
          const j = (await call('GET', `${ws()}/jobs/${id}`, admin)).body!;
          if (j['status'] === 'succeeded' || j['status'] === 'failed') return j;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`job ${id} did not finish`);
      };

      expect((await call('POST', `${ws()}/backups`, architect)).status).toBe(403);
      const backup = await runJob(await call('POST', `${ws()}/backups`, admin));
      expect(backup).toMatchObject({ kind: 'backup', status: 'succeeded', result: { checksum: expect.any(String) } });
      const list = (await call('GET', `${ws()}/backups`, admin)).body!;
      expect(list[0]).toMatchObject({ id: backup['result'].backupId, reason: 'manual', elements: backup['result'].elements });

      const verify = await runJob(await call('POST', `${ws()}/backups/verify`, admin));
      expect(verify).toMatchObject({ kind: 'verify', status: 'succeeded', result: { matches: true, differences: 0 } });

      // Restore and rebuild must name the workspace.
      expect((await call('POST', `${ws()}/backups/${list[0].id}/restore`, admin, { confirm: 'wrong' })).body).toMatchObject({ error: 'BAD_REQUEST', message: expect.stringMatching(/^Type the workspace slug/) });
      expect((await call('POST', `${ws()}/backups/rebuild`, admin, {})).status).toBe(400);
      expect((await call('POST', `${ws()}/backups/nope/restore`, admin, { confirm: 'default' })).status).toBe(404);
      const restore = await runJob(await call('POST', `${ws()}/backups/${list[0].id}/restore`, admin, { confirm: 'default' }));
      expect(restore).toMatchObject({ kind: 'restore', status: 'succeeded', result: { checksum: verify['result'].checksum } });
      // A restore replaces the shared test workspace: the test must never end while one is running,
      // so it waits as long as the jobs need under a busy machine.
    }, 180_000);

    it('meters usage and refuses writes, jobs and workspaces over the tenant limits', async () => {
      const admin = await sign('tenant-admin', ['admin']);
      const writer = await sign('quota-writer', ['architect']);
      expect((await call('GET', '/v1/admin/usage', writer)).status).toBe(403);
      const usage = (await call('GET', '/v1/admin/usage', admin)).body!;
      const metric = (m: string) => usage['metrics'].find((x: any) => x.metric === m);
      expect(metric('elements')).toMatchObject({ used: expect.any(Number), limit: 100000 });
      expect(metric('workspaces').used).toBeGreaterThanOrEqual(1);

      const existing = (await call('POST', `${ws()}/elements`, writer, { type: 'DataProduct', attrs: { name: 'Before the limit' } })).body!;
      const quotas = new UsageStore(handle.db);
      try {
        await quotas.setOverrides(LOCAL_TENANT, { elements: 0, jobsPerDay: 0, workspaces: metric('workspaces').used }, 'test');
        const refused = await call('POST', `${ws()}/elements`, writer, { type: 'DataProduct', attrs: { name: 'Over the limit' } });
        expect(refused).toMatchObject({ status: 403, body: { error: 'QUOTA_EXCEEDED', message: expect.stringMatching(/^The plan allows 0 elements/) } });
        // Imports are refused the same way; dry runs are not.
        const doc = { apiVersion: 'd4/v1', kind: 'Model', metadata: { name: 'q' }, elements: [{ key: 'x', type: 'DataProduct', name: 'Quota import' }], relationships: [] };
        expect((await call('POST', `${ws()}/import?dryRun=true`, writer, doc)).status).toBe(200);
        expect((await call('POST', `${ws()}/import`, writer, doc)).body).toMatchObject({ error: 'QUOTA_EXCEEDED' });
        expect((await call('POST', `${ws()}/jobs/export`, writer, { format: 'yaml' })).body).toMatchObject({ error: 'QUOTA_EXCEEDED' });
        expect((await call('POST', '/v1/admin/workspaces', admin, { slug: 'quota-ws', name: 'Quota' })).body).toMatchObject({ error: 'QUOTA_EXCEEDED' });
        // Changing existing elements is never limited.
        expect((await call('PATCH', `${ws()}/elements/${existing['id']}`, writer, { expectedVersion: 1, set: { description: 'still allowed' } })).status).toBe(200);
      } finally {
        await quotas.setOverrides(LOCAL_TENANT, {}, 'test');
      }
      expect((await call('POST', `${ws()}/elements`, writer, { type: 'DataProduct', attrs: { name: 'Within the limit' } })).status).toBe(201);
    });

    it('reviews change proposals: check, submit, four-eyes approval as one change, stale refusal', async () => {
      const author = await sign('proposer-1', ['contributor']);
      const reviewer = await sign('reviewer-1', ['architect']);
      const viewer = await sign('plain-viewer', ['viewer']);
      const product = (await call('POST', `${ws()}/elements`, author, { type: 'DataProduct', attrs: { name: 'Proposal target' } })).body!;

      expect((await call('POST', `${ws()}/proposals`, viewer, { title: 'x' })).status).toBe(403);
      const draft = await call('POST', `${ws()}/proposals`, author, {
        title: 'Move Proposal target to the lake',
        operations: [
          { op: 'createElement', ref: 'store', type: 'DataStore', attrs: { name: 'Proposal lake' } },
          { op: 'createRelationship', type: 'HOLDS', from: 'store', to: product['id'], attrs: { role: 'MASTER' } },
          { op: 'updateElement', id: product['id'], expectedVersion: 1, set: { description: 'Mastered in the lake' } },
        ],
      });
      expect(draft).toMatchObject({ status: 201, body: { status: 'draft', stepCount: 3, check: { ok: true } } });
      expect(draft.body!['steps'].map((s: any) => s.text)).toEqual([
        "Add DataStore 'Proposal lake'",
        "Connect DataStore 'Proposal lake' HOLDS DataProduct 'Proposal target'",
        "Change DataProduct 'Proposal target': description",
      ]);
      const id = draft.body!['id'];
      const url = `${ws()}/proposals/${id}`;
      // Nothing applied while it is a proposal.
      expect((await call('GET', `${ws()}/elements?q=proposal%20lake`, author)).body!['items']).toEqual([]);

      expect((await call('POST', `${url}/approve`, reviewer)).status).toBe(409); // still a draft
      expect((await call('POST', `${url}/submit`, author)).body).toMatchObject({ status: 'submitted' });
      expect((await call('PATCH', url, author, { title: 'late edit' })).status).toBe(409);
      expect((await call('POST', `${url}/approve`, author)).status).toBe(403); // not their own
      expect((await call('POST', `${url}/approve`, viewer)).status).toBe(403);
      expect((await call('POST', `${url}/reject`, reviewer, {})).status).toBe(400); // needs a reason

      const applied = await call('POST', `${url}/approve`, reviewer, { comment: 'Looks right' });
      expect(applied.body).toMatchObject({ status: 'applied', reviewComment: 'Looks right', check: null });
      expect((await call('POST', `${url}/approve`, reviewer)).status).toBe(409);
      const lakeId = applied.body!['steps'][0].subjectId;
      expect((await call('GET', `${ws()}/elements/${lakeId}`, author)).body).toMatchObject({ attrs: { name: 'Proposal lake' } });
      const history = (await call('GET', `${ws()}/elements/${product['id']}/history`, author)).body!;
      expect(history.at(-1)).toMatchObject({ type: 'ElementUpdated', actor: (await call('GET', '/v1/me', author)).body!['userId'], data: { proposalId: id } });

      // A proposal written against version 2 is refused once the element moves on, and says which step.
      const stale = (await call('POST', `${ws()}/proposals`, author, { title: 'Rename', operations: [{ op: 'updateElement', id: product['id'], expectedVersion: 2, set: { description: 'v3' } }] })).body!;
      await call('POST', `${ws()}/proposals/${stale['id']}/submit`, author);
      await call('PATCH', `${ws()}/elements/${product['id']}`, reviewer, { expectedVersion: 2, set: { description: 'changed directly' } });
      expect((await call('GET', `${ws()}/proposals/${stale['id']}`, reviewer)).body).toMatchObject({ check: { ok: false }, steps: [{ state: 'error' }] });
      const refused = await call('POST', `${ws()}/proposals/${stale['id']}/approve`, reviewer);
      expect(refused).toMatchObject({ status: 409, body: { message: expect.stringMatching(/^Step 1 cannot be applied/) } });
      expect((await call('POST', `${ws()}/proposals/${stale['id']}/reject`, reviewer, { comment: 'Out of date' })).body).toMatchObject({ status: 'rejected' });

      const listed = (await call('GET', `${ws()}/proposals?status=applied&status=rejected`, viewer)).body!;
      expect(listed.map((p: any) => p.id)).toEqual(expect.arrayContaining([id, stale['id']]));
      // The web client sends the statuses comma-separated.
      const joined = (await call('GET', `${ws()}/proposals?status=applied,rejected`, viewer)).body!;
      expect(joined.map((p: any) => p.id)).toEqual(expect.arrayContaining([id, stale['id']]));
    });

    it('lets admins manage webhooks: secrets shown once, URLs checked, pings queued', async () => {
      const admin = await sign('tenant-admin', ['admin']);
      expect((await call('GET', '/v1/admin/webhooks', await sign('plain-viewer', ['viewer']))).status).toBe(403);
      expect((await call('POST', '/v1/admin/webhooks', admin, { name: 'Local', url: 'https://127.0.0.1/hook' })).body).toMatchObject({ error: 'BAD_REQUEST', message: 'Webhook URL must not point to a private or local address' });
      expect((await call('POST', '/v1/admin/webhooks', admin, { name: 'Plain', url: 'http://93.184.215.14/hook' })).status).toBe(400);
      expect((await call('POST', '/v1/admin/webhooks', admin, { name: 'Bad type', url: 'https://93.184.215.14/hook', eventTypes: ['Nope'] })).status).toBe(400);

      const created = await call('POST', '/v1/admin/webhooks', admin, { name: 'CMDB sync', url: 'https://93.184.215.14/hook', workspace: 'default', eventTypes: ['ElementCreated'] });
      expect(created).toMatchObject({ status: 201, body: { name: 'CMDB sync', enabled: true, eventTypes: ['ElementCreated'], secret: expect.stringMatching(/^whsec_/) } });
      const id = created.body!['id'];
      const fetched = (await call('GET', `/v1/admin/webhooks/${id}`, admin)).body!;
      expect(fetched['secret']).toBeUndefined();
      expect(fetched['workspaceId']).toBeTruthy();

      const rotated = (await call('POST', `/v1/admin/webhooks/${id}/rotate-secret`, admin)).body!;
      expect(rotated['secret']).not.toBe(created.body!['secret']);
      const ping = await call('POST', `/v1/admin/webhooks/${id}/ping`, admin);
      expect(ping).toMatchObject({ status: 202, body: { eventType: 'Ping', status: 'pending', attempts: 0 } });
      expect((await call('GET', `/v1/admin/webhooks/${id}/deliveries`, admin)).body).toEqual([expect.objectContaining({ id: ping.body!['id'] })]);

      expect((await call('PATCH', `/v1/admin/webhooks/${id}`, admin, { enabled: false, workspace: null })).body).toMatchObject({ enabled: false, workspaceId: null });
      expect((await call('POST', `/v1/admin/webhooks/${id}/ping`, admin)).status).toBe(400);
      expect((await call('DELETE', `/v1/admin/webhooks/${id}`, admin)).status).toBe(204);
      expect((await call('GET', `/v1/admin/webhooks/${id}`, admin)).status).toBe(404);
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

    it('serves a scheduled roadmap for a scope', async () => {
      const token = await sign('analyst-3', ['viewer']);
      const res = await gql(
        token,
        `query ($ws: ID!, $scope: [ID!]!) {
           workspace(id: $ws) {
             roadmap(scope: $scope, lanes: "initiative", today: "2026-10-18") {
               start end lanesBy criticalPath
               lanes { name }
               items { name critical slackDays earliestStart }
               conflicts { kind days }
             }
           }
         }`,
        { ws: workspaceId, scope: [sampleIds['init-client-data']] },
      );
      expect(res.body!['errors']).toBeUndefined();
      const r = res.body!['data'].workspace.roadmap;
      expect(r).toMatchObject({ start: '2026-10-01', end: '2027-12-31', lanesBy: 'initiative' });
      expect(r.items).toHaveLength(8);
      expect(r.conflicts.map((c: any) => c.kind)).toEqual(['dependency-violated', 'misses-milestone']);
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
