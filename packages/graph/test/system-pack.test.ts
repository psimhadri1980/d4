import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { parseModelDocument, toImportInput } from '@d4/codecs';
import { ModelService, planImport, ulid, type CommandContext } from '@d4/core';
import { applySchema, bindParams, checkReadOnly, loadPack, type SystemQuery } from '@d4/cypher';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { Neo4jModelRepository, neo4jExplainer, type SessionProvider } from '../src';

const URL = process.env.D4_TEST_NEO4J_URL;
const PASSWORD = process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev';
const reg = new MetamodelRegistry(loadStarterMetamodel());
const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');

describe.skipIf(!URL)('system query pack on the UBS sample', () => {
  const ctx: CommandContext = { workspaceId: `pack-${ulid()}`, actor: 'tester' };
  const pack = new Map(loadPack().map((q) => [q.slug, q]));
  let driver: Driver;
  let sessions: SessionProvider;
  let keyToId: Record<string, string>;

  /** Runs a pack query the way the Query Service will: bound params plus $workspace, READ session. */
  async function run(slug: string, input: Record<string, unknown> = {}) {
    const q = pack.get(slug) as SystemQuery;
    const { values, issues } = bindParams(q.params, input);
    expect(issues).toEqual([]);
    const s = await sessions('READ');
    try {
      const res = await s.executeRead((tx) => tx.run(q.cypher, { ...values, workspace: ctx.workspaceId }));
      return res.records.map((r) => r.toObject());
    } finally {
      await s.close();
    }
  }

  beforeAll(async () => {
    driver = neo4j.driver(URL!, neo4j.auth.basic('neo4j', PASSWORD), { disableLosslessIntegers: true });
    sessions = async (mode) =>
      driver.session({ defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE });
    const s = await sessions('WRITE');
    await applySchema(s, reg);
    await s.run('CALL db.awaitIndexes(120)');
    await s.close();

    const repo = new Neo4jModelRepository(reg, sessions, { withEvents: async (_e, write) => write() });
    const doc = parseModelDocument(readFileSync(SAMPLE, 'utf8'));
    const plan = planImport(reg, ctx, toImportInput(doc), { elements: [], relationships: [] });
    expect(plan.ok).toBe(true);
    await repo.apply(ctx.workspaceId, plan.change!);
    keyToId = plan.keyToId;

    // One deliberate gap so "without master" has something to find.
    await new ModelService(reg, repo).createElement(ctx, { type: 'DataProduct', attrs: { name: 'Orphaned Feed' } });
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery('MATCH (n:Element) WHERE n.workspaceId = $ws DETACH DELETE n', { ws: ctx.workspaceId });
    await driver.close();
  });

  it('every query is read-only according to Neo4j', async () => {
    const explainer = neo4jExplainer(sessions);
    for (const q of pack.values()) {
      const params = Object.fromEntries(q.params.map((p) => [p.name, null]));
      const r = await checkReadOnly(explainer, q.cypher, { ...params, workspace: ctx.workspaceId });
      expect(r.errors, q.slug).toEqual([]);
    }
  });

  it('impact of retiring the mainframe reaches apps, stores, products and steps', async () => {
    const rows = await run('impact-of-retirement', { element: keyToId['plat-mainframe'] });
    const byName = new Map(rows.map((r) => [r['name'], r]));
    expect(byName.get('Core Banking System')).toMatchObject({ type: 'Application', hops: 1 });
    expect(byName.get('Core Banking Database')).toMatchObject({ type: 'DataStore', hops: 1 });
    expect(byName.get('Account')).toMatchObject({ type: 'DataProduct', hops: 2 });
    expect(byName.get('Open account')).toMatchObject({ type: 'ProcessStep' });
    expect(byName.has('Mainframe')).toBe(false);
  });

  it('data product holders show the master hand-over over time', async () => {
    const all = await run('data-product-holders', { element: keyToId['dp-client'] });
    expect(all.filter((r) => r['role'] === 'MASTER').map((r) => r['store'])).toEqual([
      'Client MDM Hub',
      'Legacy Client Database',
    ]);
    const before = await run('data-product-holders', { element: keyToId['dp-client'], asOf: '2027-01-01' });
    expect(before.find((r) => r['role'] === 'MASTER')?.['store']).toBe('Legacy Client Database');
    const after = await run('data-product-holders', { element: keyToId['dp-client'], asOf: '2027-08-01' });
    expect(after.find((r) => r['role'] === 'MASTER')?.['store']).toBe('Client MDM Hub');
    expect(after.map((r) => r['role'])).toContain('REPLICA');
  });

  it('CRUD-I matrix for onboarding lists steps, actors and operations', async () => {
    const rows = await run('process-crud-matrix', { element: keyToId['bp-onboarding'] });
    expect(rows.map((r) => `${r['seq']}|${r['step']}|${r['dataProduct']}|${r['operation']}`)).toEqual([
      '1|Capture client details|Client Master|CREATE',
      '2|Perform KYC screening|Client Master|READ',
      '2|Perform KYC screening|KYC Profile|CREATE',
      '3|Approve client relationship|KYC Profile|UPDATE',
      '4|Open account|Account|CREATE',
      '4|Open account|Product Reference|READ',
    ]);
    expect(rows[0]!['performedBy']).toBe('Client Advisor');
  });

  it('finds data products without a master', async () => {
    const rows = await run('data-products-without-master', { asOf: '2026-12-01' });
    expect(rows.map((r) => r['name'])).toEqual(['Orphaned Feed']);
  });

  it('flags active elements linked to deprecated ones', async () => {
    const rows = await run('lifecycle-risk');
    const pairs = rows.map((r) => `${r['element']} -${r['via']}- ${r['linkedTo']}`);
    expect(pairs).toContain('Inactivate client record -SUPPORTS_STEP- Legacy Client Administration');
    expect(rows.every((r) => ['DEPRECATED', 'RETIRED'].includes(String(r['linkedLifecycle'])))).toBe(true);
  });

  it('lists orphan elements, optionally by type', async () => {
    expect((await run('orphan-elements')).map((r) => r['name'])).toEqual(['Orphaned Feed']);
    expect(await run('orphan-elements', { types: ['Platform'] })).toEqual([]);
  });

  it('builds the Group Functions roadmap with changes and dependencies', async () => {
    const rows = await run('org-unit-roadmap', { element: keyToId['div-gf'] });
    expect(rows.map((r) => r['deliverable'])).toEqual([
      'Build Client MDM Hub',
      'Publish Client Master contract v2',
      'Launch client data quality dashboard',
      'Migrate client master to MDM Hub',
      'Re-point onboarding to MDM Hub',
      'Decommission legacy client database',
    ]);
    const decommission = rows.at(-1)!;
    expect(decommission['changes']).toEqual(
      expect.arrayContaining(['Legacy Client Database (RETIRE)', 'Legacy Client Administration (RETIRE)']),
    );
    expect(decommission['dependsOn']).toEqual(['Client master cut-over']);
  });
});
