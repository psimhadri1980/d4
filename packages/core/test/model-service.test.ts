import { beforeEach, describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { DomainError, InMemoryModelRepository, ModelService, ulid, type CommandContext } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const ctx: CommandContext = { workspaceId: 'ws1', actor: 'u1' };

let repo: InMemoryModelRepository;
let svc: ModelService;

beforeEach(() => {
  repo = new InMemoryModelRepository();
  svc = new ModelService(reg, repo);
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof DomainError ? [e.code, e.ruleId] : ['UNEXPECTED', String(e)];
  }
  return ['OK'];
};

describe('elements', () => {
  it('deleting a scenario deletes its items and leaves the baseline alone', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Client' } });
    const legacy = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Legacy' } });
    const baseline = await svc.createRelationship(ctx, { type: 'HOLDS', fromId: legacy.id, toId: dp.id, attrs: { role: 'MASTER' } });
    const s = await svc.createElement(ctx, { type: 'Scenario', attrs: { name: 'Early cut-over' } });
    const cache = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Cache' }, scenarioId: s.id });
    const early = await svc.createRelationship(ctx, {
      type: 'HOLDS', fromId: legacy.id, toId: dp.id, attrs: { role: 'MASTER' }, validTo: '2027-04-01', scenarioId: s.id,
    });
    const cached = await svc.createRelationship(ctx, { type: 'HOLDS', fromId: cache.id, toId: dp.id, attrs: { role: 'CONSUMER_CACHE' }, scenarioId: s.id });
    // Unrelated scenario: untouched.
    const other = await svc.createElement(ctx, { type: 'Scenario', attrs: { name: 'Other' } });
    const otherStore = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Other store' }, scenarioId: other.id });

    await svc.deleteElement(ctx, { id: s.id, expectedVersion: 1 });
    const gone = (id: string) => repo.elements.get(id)?.deleted ?? repo.relationships.get(id)?.deleted;
    expect([s.id, cache.id, early.id, cached.id].map(gone)).toEqual([true, true, true, true]);
    expect([dp.id, legacy.id, baseline.id, other.id, otherStore.id].map(gone)).toEqual([false, false, false, false, false]);

    const last = repo.events.at(-1)!;
    expect(last).toMatchObject({ type: 'ElementDeleted', subjectId: s.id, data: { cascadedElements: [cache.id] } });
    expect((last.data['cascadedRelationships'] as string[]).sort()).toEqual([early.id, cached.id].sort());
    expect(repo.events.filter((e) => e.data['reason'] === 'scenario-deleted').map((e) => e.subjectId).sort()).toEqual(
      [cache.id, early.id, cached.id].sort(),
    );
  });

  it('creates with defaults, system fields and an event', async () => {
    const el = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Customer' } });
    expect(el).toMatchObject({ version: 1, workspaceId: 'ws1', deleted: false, createdBy: 'u1' });
    expect(el.attrs['lifecycle']).toBe('IDEA');
    expect(repo.events.map((e) => e.type)).toEqual(['ElementCreated']);
  });

  it('rejects unknown types, missing required and bad enum values', async () => {
    expect(await code(svc.createElement(ctx, { type: 'Nope', attrs: { name: 'x' } }))).toEqual([
      'VALIDATION',
      undefined,
    ]);
    const err = await svc
      .createElement(ctx, { type: 'DataStore', attrs: { category: 'HOT' } })
      .catch((e: DomainError) => e);
    expect((err as DomainError).issues).toEqual(
      expect.arrayContaining(['DataStore.name is required', expect.stringMatching(/category must be one of/)]),
    );
  });

  it('keeps caller-supplied ULIDs and rejects duplicates', async () => {
    const id = ulid();
    await svc.createElement(ctx, { id, type: 'Platform', attrs: { name: 'Snowflake' } });
    expect(await code(svc.createElement(ctx, { id, type: 'Platform', attrs: { name: 'x' } }))).toEqual([
      'VALIDATION',
      undefined,
    ]);
  });

  it('updates with optimistic concurrency and records only real changes', async () => {
    const el = await svc.createElement(ctx, { type: 'Application', attrs: { name: 'CRM' } });
    const v2 = await svc.updateElement(ctx, {
      id: el.id,
      expectedVersion: 1,
      set: { criticality: 'HIGH', lifecycle: 'PROPOSED' },
    });
    expect(v2.version).toBe(2);
    expect(repo.events.at(-1)?.data).toEqual({
      changes: {
        'attrs.criticality': { from: null, to: 'HIGH' },
        'attrs.lifecycle': { from: 'IDEA', to: 'PROPOSED' },
      },
    });

    expect(await code(svc.updateElement(ctx, { id: el.id, expectedVersion: 1, set: { name: 'x' } }))).toEqual([
      'VERSION_CONFLICT',
      undefined,
    ]);
    const same = await svc.updateElement(ctx, { id: el.id, expectedVersion: 2, set: { name: 'CRM' } });
    expect(same.version).toBe(2);
  });

  it('enforces lifecycle transitions', async () => {
    const el = await svc.createElement(ctx, { type: 'Application', attrs: { name: 'CRM' } });
    expect(
      await code(svc.updateElement(ctx, { id: el.id, expectedVersion: 1, set: { lifecycle: 'LIVE' } })),
    ).toEqual(['INVALID_TRANSITION', undefined]);
  });

  it('soft-deletes and cascades to attached relationships', async () => {
    const store = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'MDM' } });
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Customer' } });
    const rel = await svc.createRelationship(ctx, {
      type: 'HOLDS',
      fromId: store.id,
      toId: dp.id,
      attrs: { role: 'MASTER' },
    });

    await svc.deleteElement(ctx, { id: store.id, expectedVersion: 1 });
    expect(repo.elements.get(store.id)?.deleted).toBe(true);
    expect(repo.relationships.get(rel.id)).toMatchObject({ deleted: true, version: 2 });
    expect(repo.events.slice(-2).map((e) => e.type)).toEqual(['RelationshipDeleted', 'ElementDeleted']);
    expect(await code(svc.updateElement(ctx, { id: store.id, expectedVersion: 2, set: {} }))).toEqual([
      'NOT_FOUND',
      undefined,
    ]);
  });

  it('isolates workspaces', async () => {
    const el = await svc.createElement(ctx, { type: 'Platform', attrs: { name: 'K8s' } });
    const other = { workspaceId: 'ws2', actor: 'u1' };
    expect(await code(svc.updateElement(other, { id: el.id, expectedVersion: 1, set: {} }))).toEqual([
      'NOT_FOUND',
      undefined,
    ]);
  });
});

describe('relationships', () => {
  it('only connects types the metamodel allows (including via inheritance)', async () => {
    const div = await svc.createElement(ctx, { type: 'Division', attrs: { name: 'Retail' } });
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Customer' } });
    const app = await svc.createElement(ctx, { type: 'Application', attrs: { name: 'CRM' } });

    expect(await code(svc.createRelationship(ctx, { type: 'OWNS', fromId: div.id, toId: dp.id }))).toEqual(['OK']);
    expect(
      await code(
        svc.createRelationship(ctx, { type: 'ACTS_ON', fromId: app.id, toId: dp.id, attrs: { op: 'READ' } }),
      ),
    ).toEqual(['VALIDATION', undefined]);
  });

  it('allows one MASTER per data product per overlapping period', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Customer' } });
    const a = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Legacy MDM' } });
    const b = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'New MDM' } });
    const c = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Lake' } });

    await svc.createRelationship(ctx, {
      type: 'HOLDS', fromId: a.id, toId: dp.id, attrs: { role: 'MASTER' }, validTo: '2027-01-01',
    });
    // Overlapping second master is rejected…
    expect(
      await code(svc.createRelationship(ctx, { type: 'HOLDS', fromId: b.id, toId: dp.id, attrs: { role: 'MASTER' } })),
    ).toEqual(['RULE_VIOLATION', 'single-master-per-data-product']);
    // …but a planned hand-over after the old one ends is fine, as is a distributor.
    expect(
      await code(
        svc.createRelationship(ctx, {
          type: 'HOLDS', fromId: b.id, toId: dp.id, attrs: { role: 'MASTER' }, validFrom: '2027-01-01',
        }),
      ),
    ).toEqual(['OK']);
    expect(
      await code(
        svc.createRelationship(ctx, { type: 'HOLDS', fromId: c.id, toId: dp.id, attrs: { role: 'APPROVED_DISTRIBUTOR' } }),
      ),
    ).toEqual(['OK']);
  });

  it('checks uniqueness when a role is changed', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Customer' } });
    const a = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'A' } });
    const b = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'B' } });
    await svc.createRelationship(ctx, { type: 'HOLDS', fromId: a.id, toId: dp.id, attrs: { role: 'GOLDEN_COPY' } });
    const rb = await svc.createRelationship(ctx, { type: 'HOLDS', fromId: b.id, toId: dp.id, attrs: { role: 'REPLICA' } });
    expect(
      await code(svc.updateRelationship(ctx, { id: rb.id, expectedVersion: 1, set: { role: 'GOLDEN_COPY' } })),
    ).toEqual(['RULE_VIOLATION', 'single-golden-copy-per-data-product']);
  });

  it('rejects dependency cycles', async () => {
    const [d1, d2, d3] = await Promise.all(
      ['Build', 'Migrate', 'Decommission'].map((name) =>
        svc.createElement(ctx, { type: 'Deliverable', attrs: { name } }),
      ),
    );
    await svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d2!.id, toId: d1!.id });
    await svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d3!.id, toId: d2!.id });
    expect(await code(svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d1!.id, toId: d3!.id }))).toEqual([
      'RULE_VIOLATION',
      'no-dependency-cycles',
    ]);
    expect(await code(svc.createRelationship(ctx, { type: 'DEPENDS_ON', fromId: d1!.id, toId: d1!.id }))).toEqual([
      'RULE_VIOLATION',
      'no-dependency-cycles',
    ]);
  });

  it('refuses to connect deleted elements', async () => {
    const div = await svc.createElement(ctx, { type: 'Division', attrs: { name: 'Retail' } });
    const app = await svc.createElement(ctx, { type: 'Application', attrs: { name: 'CRM' } });
    await svc.deleteElement(ctx, { id: app.id, expectedVersion: 1 });
    expect(await code(svc.createRelationship(ctx, { type: 'OWNS', fromId: div.id, toId: app.id }))).toEqual([
      'NOT_FOUND',
      undefined,
    ]);
  });
});
