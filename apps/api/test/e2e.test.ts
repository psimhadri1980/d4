import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import neo4j from 'neo4j-driver';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { parseModelDocument } from '@d4/codecs';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { JobQueue, processJob, S3ArtifactStore, startJobWorker } from '@d4/jobs';
import { createDb, RoleStore, runMigrations, seedLocal, type DbHandle } from '@d4/db';
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
      POSTGRES_URL: url.toString(),
      NEO4J_PASSWORD: NEO_PASSWORD,
      NEO4J_URI: NEO,
      OIDC_ISSUER: ISSUER,
      // Jobs: a queue of our own, so a running dev worker does not take these jobs.
      REDIS_URL: REDIS ?? '',
      S3_ENDPOINT: S3 ?? '',
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
