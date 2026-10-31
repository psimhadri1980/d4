import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { InMemoryModelRepository } from '../src/testing';
import { compareStates, emptyState, ModelService, replayEvents, stageProposal, type CommandContext, type ModelState } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const ctx: CommandContext = { workspaceId: 'ws1', actor: 'u1' };
const stateOf = (repo: InMemoryModelRepository): ModelState => ({ elements: new Map(repo.elements), relationships: new Map(repo.relationships) });

/** A small history: creates, updates (including clearing an attribute and validity), a cascade delete and an import-style batch. */
async function history() {
  const repo = new InMemoryModelRepository();
  const svc = new ModelService(reg, repo);
  const dp = await svc.createElement(ctx, { type: 'DataProduct', attrs: { name: 'Client', description: 'old' } });
  const store = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Lake' }, validFrom: '2026-01-01' });
  const holds = await svc.createRelationship(ctx, { type: 'HOLDS', fromId: store.id, toId: dp.id, attrs: { role: 'MASTER' } });
  await svc.updateElement(ctx, { id: dp.id, expectedVersion: 1, set: { lifecycle: 'PROPOSED' }, unset: ['description'] });
  await svc.updateElement(ctx, { id: store.id, expectedVersion: 1, validFrom: null, validTo: '2030-01-01' });
  await svc.updateRelationship(ctx, { id: holds.id, expectedVersion: 1, set: { role: 'GOLDEN_COPY' } });
  const old = await svc.createElement(ctx, { type: 'DataStore', attrs: { name: 'Old' } });
  await svc.createRelationship(ctx, { type: 'HOLDS', fromId: old.id, toId: dp.id, attrs: { role: 'REPLICA' } });
  await svc.deleteElement(ctx, { id: old.id, expectedVersion: 1 });
  const staged = await stageProposal(reg, repo, ctx, [{ op: 'createElement', ref: 'x', type: 'Application', attrs: { name: 'CRM' } }]);
  await repo.apply('ws1', staged.change!);
  return repo;
}

describe('replayEvents', () => {
  it('rebuilds exactly the state the commands produced', async () => {
    const repo = await history();
    const replayed = replayEvents(emptyState(), repo.events);
    expect(replayed.problems).toEqual([]);
    expect(replayed.applied).toBe(repo.events.length);
    expect(compareStates(replayed, stateOf(repo))).toEqual({ differences: [], count: 0 });
  });

  it('converges from a snapshot taken mid-history when events it already has are replayed again', async () => {
    const repo = await history();
    const cut = 5;
    const snapshot = replayEvents(emptyState(), repo.events.slice(0, cut));
    // The snapshot "saw" two later events too, as a snapshot racing writes would.
    const raced = replayEvents(snapshot, repo.events.slice(cut, cut + 2));
    const result = replayEvents(raced, repo.events.slice(cut));
    expect(result.skipped).toBe(2);
    expect(compareStates(result, stateOf(repo)).count).toBe(0);
  });

  it('reports gaps and unknown items instead of guessing', async () => {
    const repo = await history();
    const withoutCreate = repo.events.filter((e, i) => i !== 0);
    const r = replayEvents(emptyState(), withoutCreate);
    expect(r.problems[0]).toMatch(/ElementUpdated .* expected v1|unknown item/);
  });

  it('names what differs between two states', async () => {
    const repo = await history();
    const graph = stateOf(repo);
    const [first] = graph.elements.keys();
    graph.elements.delete(first!);
    const someRel = [...graph.relationships.values()][0]!;
    graph.relationships.set(someRel.id, { ...someRel, attrs: { ...someRel.attrs, role: 'CONSUMER_CACHE' } });
    const diff = compareStates(replayEvents(emptyState(), repo.events), graph);
    expect(diff.count).toBe(2);
    expect(diff.differences.join('\n')).toMatch(/missing from the graph[\s\S]*differs/);
  });
});
