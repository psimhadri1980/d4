import { beforeEach, describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { InMemoryModelRepository } from '../src/testing';
import {
  planImport,
  type CommandContext,
  type ImportInput,
  type ModelSnapshot,
} from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const ctx: CommandContext = { workspaceId: 'ws1', actor: 'importer' };

const input: ImportInput = {
  elements: [
    { key: 'retail', type: 'Division', attrs: { name: 'Retail' } },
    { key: 'customer', type: 'DataProduct', attrs: { name: 'Customer', lifecycle: 'LIVE' } },
    { key: 'mdm', type: 'DataStore', attrs: { name: 'MDM Hub' } },
  ],
  relationships: [
    { type: 'OWNS', from: 'retail', to: 'customer' },
    { type: 'HOLDS', from: 'mdm', to: 'customer', attrs: { role: 'MASTER' } },
  ],
};

let repo: InMemoryModelRepository;
const snapshot = (): ModelSnapshot => ({
  elements: [...repo.elements.values()],
  relationships: [...repo.relationships.values()],
});
const apply = async (i: ImportInput) => {
  const plan = planImport(reg, ctx, i, snapshot());
  if (plan.change) await repo.apply(ctx.workspaceId, plan.change);
  return plan;
};

beforeEach(() => {
  repo = new InMemoryModelRepository();
});

describe('planImport', () => {
  it('creates everything on first import, in one change set', async () => {
    const plan = await apply(input);
    expect(plan.ok).toBe(true);
    expect(plan.elements).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(plan.relationships).toEqual({ created: 2, updated: 0, unchanged: 0 });
    expect(repo.events.every((e) => e.data['source'] === 'import')).toBe(true);
    const customer = repo.elements.get(plan.keyToId['customer']!);
    expect(customer?.attrs['lifecycle']).toBe('LIVE');
  });

  it('is idempotent: re-importing matches by type + name and changes nothing', async () => {
    await apply(input);
    const again = await apply(input);
    expect(again.elements).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(again.relationships).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(again.change?.events).toEqual([]);
    expect(repo.elements.size).toBe(3);
  });

  it('updates changed attributes and bumps versions', async () => {
    const first = await apply(input);
    const plan = await apply({
      elements: [{ key: 'customer', type: 'DataProduct', attrs: { name: 'Customer', sla: '99.9%' } }],
      relationships: [],
    });
    expect(plan.elements).toEqual({ created: 0, updated: 1, unchanged: 0 });
    const customer = repo.elements.get(first.keyToId['customer']!)!;
    expect(customer).toMatchObject({ version: 2, attrs: { sla: '99.9%', lifecycle: 'LIVE' } });
  });

  it('references existing elements by id from a later import', async () => {
    const first = await apply(input);
    const plan = await apply({
      elements: [{ key: 'dwh', type: 'DataStore', attrs: { name: 'DWH' } }],
      relationships: [
        { type: 'HOLDS', from: 'dwh', to: first.keyToId['customer']!, attrs: { role: 'APPROVED_DISTRIBUTOR' } },
      ],
    });
    expect(plan.ok).toBe(true);
    expect(plan.relationships.created).toBe(1);
  });

  it('reports every problem and plans nothing when invalid', async () => {
    await apply(input);
    const plan = planImport(
      reg,
      ctx,
      {
        elements: [
          { key: 'crm', type: 'DataStore', attrs: { name: 'CRM' } },
          { key: 'crm', type: 'DataStore', attrs: { name: 'CRM 2' } },
          { key: 'x', type: 'Nope', attrs: { name: 'x' } },
          { key: 'customer', type: 'DataProduct', attrs: { name: 'Customer', lifecycle: 'IDEA' } },
        ],
        relationships: [
          { type: 'HOLDS', from: 'crm', to: 'customer', attrs: { role: 'MASTER' } },
          { type: 'OWNS', from: 'ghost', to: 'customer' },
        ],
      },
      snapshot(),
    );
    expect(plan.ok).toBe(false);
    expect(plan.change).toBeUndefined();
    const messages = plan.issues.map((i) => i.ruleId ?? i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "duplicate key 'crm'",
        "unknown element type 'Nope'",
        'lifecycle cannot move from LIVE to IDEA',
        "unknown element 'ghost'",
        'single-master-per-data-product',
      ]),
    );
  });

  it('flags ambiguous name matches', async () => {
    await apply({
      elements: [
        { key: 'a', type: 'Platform', attrs: { name: 'Kafka', externalKey: 'P-1' } },
        { key: 'b', type: 'Platform', attrs: { name: 'Kafka', externalKey: 'P-2' } },
      ],
      relationships: [],
    });
    const byName = planImport(reg, ctx, { elements: [{ key: 'k', type: 'Platform', attrs: { name: 'Kafka' } }], relationships: [] }, snapshot());
    expect(byName.issues[0]?.message).toMatch(/several existing Platform/);
    const byExternalKey = planImport(
      reg,
      ctx,
      { elements: [{ key: 'k', type: 'Platform', attrs: { name: 'Kafka', externalKey: 'P-2', tags: ['x'] } }], relationships: [] },
      snapshot(),
    );
    expect(byExternalKey.ok).toBe(true);
    expect(byExternalKey.elements.updated).toBe(1);
  });
});
