import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { applyView, DomainError, ModelService, ulid, type CommandContext, type DomainEvent } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { checkReadOnly } from '@d4/cypher';
import { GraphQueries, luceneQuery, Neo4jModelRepository, neo4jExplainer, type EventSink, type SessionProvider } from '../src';

const URL = process.env.D4_TEST_NEO4J_URL;
const PASSWORD = process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev';
const reg = new MetamodelRegistry(loadStarterMetamodel());

describe('luceneQuery', () => {
  it('escapes operators and prefix-matches each term', () => {
    expect(luceneQuery('Customer  data')).toBe('+customer* +data*');
    expect(luceneQuery('a:b (c)')).toBe('+a\\:b* +\\(c\\)*');
    expect(luceneQuery('Early cut-over a/b')).toBe('+early* +cut* +over* +a* +b*');
  });
});

describe.skipIf(!URL)('Neo4j repository and queries', () => {
  // A throwaway workspace on the shared dev database; removed afterwards.
  const ctx: CommandContext = { workspaceId: `test-${ulid()}`, actor: 'tester' };
  let driver: Driver;
  let sessions: SessionProvider;
  let logged: DomainEvent[];
  let failNextLog = false;
  let svc: ModelService;
  let q: GraphQueries;

  const sink: EventSink = {
    async withEvents(events, write) {
      await write();
      if (failNextLog) {
        failNextLog = false;
        throw new Error('event log unavailable');
      }
      logged.push(...events);
    },
  };

  const code = async (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e) => (e instanceof DomainError ? `${e.code}${e.ruleId ? `:${e.ruleId}` : ''}` : String(e)),
    );

  beforeAll(async () => {
    driver = neo4j.driver(URL!, neo4j.auth.basic('neo4j', PASSWORD), { disableLosslessIntegers: true });
    sessions = async (mode) =>
      driver.session({ defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE });
    // Idempotent; makes the suite work against a fresh Neo4j (e.g. CI) as well as the dev stack.
    const s = await sessions('WRITE');
    await applySchema(s, reg);
    await awaitSchemaOnline(s);
    await s.close();

    logged = [];
    svc = new ModelService(reg, new Neo4jModelRepository(reg, sessions, sink));
    q = new GraphQueries(reg, sessions);
  });

  afterAll(async () => {
    if (!driver) return;
    const s = await sessions('WRITE');
    await s.run('MATCH (n:Element) WHERE n.workspaceId = $ws DETACH DELETE n', { ws: ctx.workspaceId });
    await s.close();
    await driver.close();
  });

  it('round-trips an element with labels, attributes and system fields', async () => {
    const dp = await svc.createElement(ctx, {
      type: 'DataProduct',
      attrs: { name: 'Customer', classification: 'CONFIDENTIAL', tags: ['core', 'pii'] },
      validFrom: '2026-01-01',
    });
    const repo = new Neo4jModelRepository(reg, sessions, sink);
    expect(await repo.getElement(ctx.workspaceId, dp.id)).toEqual(dp);

    const s = await sessions('READ');
    const res = await s.run('MATCH (n {id: $id}) RETURN labels(n) AS l', { id: dp.id });
    await s.close();
    expect(res.records[0]!.get('l')).toEqual(expect.arrayContaining(['Element', 'DataLayer', 'DataProduct']));
    expect(logged.at(-1)?.type).toBe('ElementCreated');
  });

  it('updates with version checks and removes unset attributes', async () => {
    const app = await svc.createElement(ctx, { type: 'Application', attrs: { name: 'CRM', criticality: 'HIGH' } });
    const v2 = await svc.updateElement(ctx, {
      id: app.id,
      expectedVersion: 1,
      set: { lifecycle: 'PROPOSED' },
      unset: ['criticality'],
    });
    const stored = await q.getElement(ctx.workspaceId, app.id);
    expect(stored?.version).toBe(2);
    expect(stored?.attrs).toEqual({ name: 'CRM', lifecycle: 'PROPOSED' });
    expect(v2).toEqual(stored);
    expect(await code(svc.updateElement(ctx, { id: app.id, expectedVersion: 1, set: { name: 'x' } }))).toBe(
      'VERSION_CONFLICT',
    );
  });

  it('enforces single master and allows hand-over periods', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Account' } });
    const [a, b] = await Promise.all(
      ['Core Banking', 'New Core'].map((name) => svc.createElement(ctx, { type: 'DataStore', attrs: { name } })),
    );
    await svc.createRelationship(ctx, {
      type: 'HOLDS', fromId: a!.id, toId: dp.id, attrs: { role: 'MASTER' }, validTo: '2027-07-01',
    });
    expect(
      await code(svc.createRelationship(ctx, { type: 'HOLDS', fromId: b!.id, toId: dp.id, attrs: { role: 'MASTER' } })),
    ).toBe('RULE_VIOLATION:single-master-per-data-product');
    expect(
      await code(
        svc.createRelationship(ctx, {
          type: 'HOLDS', fromId: b!.id, toId: dp.id, attrs: { role: 'MASTER' }, validFrom: '2027-07-01',
        }),
      ),
    ).toBe('OK');
  });

  it('detects dependency cycles through stored paths', async () => {
    const [d1, d2, d3] = await Promise.all(
      ['Design', 'Build', 'Launch'].map((name) => svc.createElement(ctx, { type: 'Deliverable', attrs: { name } })),
    );
    await svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d2!.id, toId: d1!.id });
    await svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d3!.id, toId: d2!.id });
    expect(await code(svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d1!.id, toId: d3!.id }))).toBe(
      'RULE_VIOLATION:no-dependency-cycles',
    );
  });

  it('finds relationships by id and cascades element deletes', async () => {
    const div = await svc.createElement(ctx, { type: 'Division', attrs: { name: 'Retail' } });
    const app = await svc.createElement(ctx, { type: 'Application', attrs: { name: 'Branch App' } });
    const owns = await svc.createRelationship(ctx, { type: 'OWNS', fromId: div.id, toId: app.id });

    const repo = new Neo4jModelRepository(reg, sessions, sink);
    expect(await repo.getRelationship(ctx.workspaceId, owns.id)).toEqual(owns);

    await svc.deleteElement(ctx, { id: app.id, expectedVersion: 1 });
    expect((await repo.getRelationship(ctx.workspaceId, owns.id))?.deleted).toBe(true);
    expect(await q.getElement(ctx.workspaceId, app.id)).toBeUndefined();
    expect(await q.connections(ctx.workspaceId, div.id)).toEqual([]);
  });

  it('lists, filters, pages and searches elements', async () => {
    for (const name of ['Payments Hub', 'Payments Gateway', 'Ledger']) {
      await svc.createElement(ctx, { type: 'Platform', attrs: { name } });
    }
    const platforms = await q.listElements(ctx.workspaceId, { types: ['Platform'] }, { first: 2 });
    expect(platforms.items).toHaveLength(2);
    expect(platforms.hasMore).toBe(true);
    const rest = await q.listElements(ctx.workspaceId, { types: ['Platform'] }, { after: platforms.endCursor! });
    expect(rest.items.map((e) => e.attrs['name'])).toEqual(['Ledger']);

    // Supertype and layer filters use labels.
    const orgUnits = await q.listElements(ctx.workspaceId, { types: ['OrgUnit'] });
    expect(orgUnits.items.map((e) => e.type)).toContain('Division');
    const tech = await q.listElements(ctx.workspaceId, { layer: 'Technology' });
    expect(tech.items.every((e) => e.type === 'Platform')).toBe(true);

    // Hyphenated names are found by their hyphenated spelling.
    await svc.createElement(ctx, { type: 'Platform', attrs: { name: 'Cut-over Runner' } });
    expect((await q.listElements(ctx.workspaceId, { search: 'cut-over' })).items.map((e) => e.attrs['name'])).toEqual(['Cut-over Runner']);

    const found = await q.listElements(ctx.workspaceId, { search: 'paym' });
    expect(found.items.map((e) => e.attrs['name']).sort()).toEqual(['Payments Gateway', 'Payments Hub']);

    // An exact name match ranks first, even against longer names with the same words.
    await svc.createElement(ctx, { type: 'Platform', attrs: { name: 'Payments Hub Gateway Hub Payments' } });
    const exact = await q.listElements(ctx.workspaceId, { search: 'payments hub' });
    expect(exact.items[0]!.attrs['name']).toBe('Payments Hub');
  });

  it('returns a neighbourhood subgraph', async () => {
    const div = await svc.createElement(ctx, { type: 'Division', attrs: { name: 'Treasury' } });
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'FX Rates' } });
    const store = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Market Data DB' } });
    await svc.createRelationship(ctx, { type: 'OWNS', fromId: div.id, toId: dp.id });
    await svc.createRelationship(ctx, { type: 'HOLDS', fromId: store.id, toId: dp.id, attrs: { role: 'GOLDEN_COPY' } });

    const one = await q.neighbourhood(ctx.workspaceId, div.id, { depth: 1 });
    expect(one?.elements.map((e) => e.attrs['name'])).toEqual(['FX Rates']);
    const two = await q.neighbourhood(ctx.workspaceId, div.id, { depth: 2 });
    expect(two?.elements.map((e) => e.attrs['name']).sort()).toEqual(['FX Rates', 'Market Data DB']);
    expect(two?.relationships.map((r) => r.type).sort()).toEqual(['HOLDS', 'OWNS']);

    const holdsOnly = await q.neighbourhood(ctx.workspaceId, dp.id, { types: ['HOLDS'] });
    expect(holdsOnly?.elements.map((e) => e.attrs['name'])).toEqual(['Market Data DB']);

    const lonely = await svc.createElement(ctx, { type: 'Division', attrs: { name: 'Empty' } });
    expect(await q.neighbourhood(ctx.workspaceId, lonely.id)).toMatchObject({ elements: [], relationships: [] });
  });

  it('filters reads by date and scenario, with scenario relationships replacing the baseline', async () => {
    const vctx: CommandContext = { workspaceId: ctx.workspaceId, actor: 'tester' };
    const dp = await svc.createElement(vctx, { type: 'DataProduct', attrs: { name: 'View Product' } });
    const legacy = await svc.createElement(vctx, { type: 'DataStore', attrs: { name: 'View Legacy' } });
    const mdm = await svc.createElement(vctx, { type: 'DataStore', attrs: { name: 'View MDM' }, validFrom: '2027-01-01' });
    const fast = await svc.createElement(vctx, { type: 'Scenario', attrs: { name: 'View Fast' } });
    const cache = await svc.createElement(vctx, { type: 'DataStore', attrs: { name: 'View Cache' }, scenarioId: fast.id });
    const holds = (fromId: string, role: string, p: { validFrom?: string; validTo?: string; scenarioId?: string } = {}) =>
      svc.createRelationship(vctx, { type: 'HOLDS', fromId, toId: dp.id, attrs: { role }, ...p });
    await holds(legacy.id, 'MASTER', { validTo: '2027-07-01' });
    await holds(mdm.id, 'MASTER', { validFrom: '2027-07-01' });
    await holds(legacy.id, 'MASTER', { validTo: '2027-04-01', scenarioId: fast.id });
    await holds(mdm.id, 'MASTER', { validFrom: '2027-04-01', scenarioId: fast.id });
    await holds(cache.id, 'CONSUMER_CACHE', { scenarioId: fast.id });

    const names = (list: { attrs: Record<string, unknown> }[]) => list.map((e) => String(e.attrs['name'])).sort();
    const listed = async (view: { asOf?: string; scenarioId?: string }) =>
      names((await q.listElements(ctx.workspaceId, { search: 'view' }, {}, view)).items);
    expect(await listed({})).toEqual(['View Fast', 'View Legacy', 'View MDM', 'View Product']);
    expect(await listed({ asOf: '2026-12-01' })).toEqual(['View Fast', 'View Legacy', 'View Product']);
    expect(await listed({ scenarioId: fast.id })).toContain('View Cache');

    const masters = async (view: { asOf?: string; scenarioId?: string }) =>
      (await q.connections(ctx.workspaceId, dp.id, { direction: 'IN', types: ['HOLDS'] }, view))
        .filter((c) => c.relationship.attrs['role'] === 'MASTER')
        .map((c) => c.other.attrs['name']);
    expect(await masters({ asOf: '2027-05-01' })).toEqual(['View Legacy']);
    expect(await masters({ asOf: '2027-05-01', scenarioId: fast.id })).toEqual(['View MDM']);

    const hood = await q.neighbourhood(ctx.workspaceId, dp.id, { view: { asOf: '2027-05-01', scenarioId: fast.id } });
    expect(names(hood!.elements)).toEqual(['View Cache', 'View MDM']);

    // The Cypher view and the pure one in @d4/core agree.
    for (const view of [{ asOf: '2027-05-01' }, { asOf: '2027-05-01', scenarioId: fast.id }, { asOf: '2027-08-01', scenarioId: fast.id }]) {
      const viaCypher = await q.snapshot(ctx.workspaceId, view);
      const viaCore = applyView(await q.snapshot(ctx.workspaceId), view);
      expect(viaCypher.relationships.map((r) => r.id).sort()).toEqual(viaCore.relationships.map((r) => r.id).sort());
      expect(viaCypher.elements.map((e) => e.id).sort()).toEqual(viaCore.elements.map((e) => e.id).sort());
    }

    // Deleting the scenario removes its items; the baseline hand-over stays.
    await svc.deleteElement(vctx, { id: fast.id, expectedVersion: 1 });
    expect(await listed({})).not.toContain('View Fast');
    expect(names((await q.listElements(ctx.workspaceId, { search: 'view cache' }, {}, { scenarioId: fast.id })).items)).toEqual([]);
    const live = await q.snapshot(ctx.workspaceId);
    expect(live.relationships.filter((r) => r.scenarioId === fast.id)).toEqual([]);
    expect(await masters({ asOf: '2027-05-01' })).toEqual(['View Legacy']);
  });

  it('rejects unknown types in queries instead of interpolating them', async () => {
    await expect(q.listElements(ctx.workspaceId, { types: ['Nope'] })).rejects.toThrow(/Unknown element type/);
    await expect(q.connections(ctx.workspaceId, 'x', { types: ['X]-() DETACH DELETE n //'] })).rejects.toThrow(
      /Unknown relationship type/,
    );
  });

  it('classifies queries with EXPLAIN without running them', async () => {
    const explainer = neo4jExplainer(sessions);
    const params = { workspace: ctx.workspaceId };
    expect(await explainer.explain('MATCH (n:Element) WHERE n.workspaceId = $workspace RETURN n LIMIT 1', params)).toBe('r');
    const write = 'MATCH (n:Element) WHERE n.workspaceId = $workspace SET n.hacked = true RETURN n';
    expect(await explainer.explain(write, params)).toBe('rw');
    expect((await checkReadOnly(explainer, write, params)).errors[0]).toMatch(/not read-only/);
    // EXPLAIN planned but did not execute the write.
    const s = await sessions('READ');
    const res = await s.run('MATCH (n:Element) WHERE n.workspaceId = $ws AND n.hacked = true RETURN count(n) AS c', { ws: ctx.workspaceId });
    await s.close();
    expect(Number(res.records[0]!.get('c'))).toBe(0);
    expect((await checkReadOnly(explainer, 'MATC (n) RETURN n', {})).errors[0]).toMatch(/Neo4j rejected the query/);
  });

  it('surfaces event-log failures to the caller', async () => {
    failNextLog = true;
    expect(await code(svc.createElement(ctx, { type: 'Platform', attrs: { name: 'Orphan' } }))).toBe(
      'Error: event log unavailable',
    );
  });
});
