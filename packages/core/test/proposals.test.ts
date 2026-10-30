import { beforeEach, describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { InMemoryModelRepository } from '../src/testing';
import { ModelService, stageProposal, type CommandContext } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const ctx: CommandContext = { workspaceId: 'ws1', actor: 'u1' };

let repo: InMemoryModelRepository;
let svc: ModelService;

beforeEach(() => {
  repo = new InMemoryModelRepository();
  svc = new ModelService(reg, repo);
});

describe('stageProposal', () => {
  it('stages steps that build on each other and applies them as one change', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Client' } });
    const before = repo.events.length;

    const staged = await stageProposal(reg, repo, ctx, [
      { op: 'createElement', ref: 'lake', type: 'DataStore', attrs: { name: 'Lake' } },
      { op: 'createRelationship', type: 'HOLDS', from: 'lake', to: dp.id, attrs: { role: 'MASTER' } },
      { op: 'updateElement', id: dp.id, expectedVersion: 1, set: { description: 'Golden client data' } },
    ]);
    expect(staged.ok).toBe(true);
    expect(staged.steps.map((s) => s.error)).toEqual([undefined, undefined, undefined]);
    // Nothing written yet.
    expect(repo.events.length).toBe(before);
    expect(repo.elements.has(staged.refs['lake']!)).toBe(false);

    await repo.apply('ws1', staged.change!);
    expect(repo.elements.get(staged.refs['lake']!)).toMatchObject({ attrs: { name: 'Lake' } });
    expect(repo.elements.get(dp.id)).toMatchObject({ version: 2, attrs: { description: 'Golden client data' } });
    expect(repo.events.slice(before).map((e) => e.type)).toEqual(['ElementCreated', 'RelationshipCreated', 'ElementUpdated']);
  });

  it('sees its own earlier steps when checking rules', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Client' } });
    const staged = await stageProposal(reg, repo, ctx, [
      { op: 'createElement', ref: 'a', type: 'DataStore', attrs: { name: 'A' } },
      { op: 'createElement', ref: 'b', type: 'DataStore', attrs: { name: 'B' } },
      { op: 'createRelationship', type: 'HOLDS', from: 'a', to: dp.id, attrs: { role: 'MASTER' } },
      { op: 'createRelationship', type: 'HOLDS', from: 'b', to: dp.id, attrs: { role: 'MASTER' } },
    ]);
    expect(staged.ok).toBe(false);
    expect(staged.steps).toHaveLength(4);
    expect(staged.steps[3]!.error).toMatchObject({ code: 'RULE_VIOLATION' });
    expect(staged.change).toBeUndefined();
  });

  it('finds dependency cycles that only exist with the staged relationships', async () => {
    const a = await svc.createElement(ctx, { type: 'Deliverable', attrs: { name: 'A' } });
    const b = await svc.createElement(ctx, { type: 'Deliverable', attrs: { name: 'B' } });
    const staged = await stageProposal(reg, repo, ctx, [
      { op: 'createRelationship', type: 'DEPENDS_ON', from: a.id, to: b.id },
      { op: 'createRelationship', type: 'DEPENDS_ON', from: b.id, to: a.id },
    ]);
    expect(staged.steps[1]!.error).toMatchObject({ code: 'RULE_VIOLATION' });
  });

  it('reports stale versions and refuses a second change to the same item', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Client' } });
    await svc.updateElement(ctx, { id: dp.id, expectedVersion: 1, set: { description: 'changed meanwhile' } });
    const stale = await stageProposal(reg, repo, ctx, [{ op: 'updateElement', id: dp.id, expectedVersion: 1, set: { description: 'x' } }]);
    expect(stale.steps[0]!.error).toMatchObject({ code: 'VERSION_CONFLICT' });

    const twice = await stageProposal(reg, repo, ctx, [
      { op: 'updateElement', id: dp.id, expectedVersion: 2, set: { description: 'one' } },
      { op: 'updateElement', id: dp.id, expectedVersion: 3, set: { description: 'two' } },
    ]);
    expect(twice.steps[1]!.error).toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/more than once/) });
  });

  it('deleting an element in a proposal also deletes its relationships in the same change', async () => {
    const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Client' } });
    const store = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Old' } });
    const holds = await svc.createRelationship(ctx, { type: 'HOLDS', fromId: store.id, toId: dp.id, attrs: { role: 'REPLICA' } });
    const staged = await stageProposal(reg, repo, ctx, [{ op: 'deleteElement', id: store.id, expectedVersion: 1 }]);
    expect(staged.ok).toBe(true);
    await repo.apply('ws1', staged.change!);
    expect(repo.relationships.get(holds.id)!.deleted).toBe(true);
  });
});
