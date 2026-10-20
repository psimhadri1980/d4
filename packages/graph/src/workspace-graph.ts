import type { Element, ModelState, Relationship } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';
import { elementToProps, ident, propsToElement, relationshipToProps } from './mapping';
import { toRelationship, type SessionProvider } from './repository';

const PAGE = 2000;

/**
 * Every element and relationship of one workspace, deleted ones included (they are part of the
 * history the event log describes). Read in pages ordered by id, so memory stays flat per page.
 */
export async function readWorkspaceGraph(sessions: SessionProvider, workspaceId: string): Promise<ModelState> {
  const session = await sessions('READ');
  const state: ModelState = { elements: new Map(), relationships: new Map() };
  try {
    for (let after = ''; ; ) {
      const res = await session.run(
        'MATCH (n:Element) WHERE n.workspaceId = $ws AND n.id > $after RETURN properties(n) AS p ORDER BY n.id LIMIT toInteger($page)',
        { ws: workspaceId, after, page: PAGE },
      );
      for (const r of res.records) {
        const el = propsToElement(r.get('p'));
        state.elements.set(el.id, el);
        after = el.id;
      }
      if (res.records.length < PAGE) break;
    }
    for (let after = ''; ; ) {
      const res = await session.run(
        `MATCH (a:Element)-[r]->(b:Element) WHERE r.workspaceId = $ws AND r.id > $after
         RETURN properties(r) AS p, type(r) AS t, a.id AS f, b.id AS o ORDER BY r.id LIMIT toInteger($page)`,
        { ws: workspaceId, after, page: PAGE },
      );
      for (const r of res.records) {
        const rel = toRelationship(r.toObject());
        state.relationships.set(rel.id, rel);
        after = rel.id;
      }
      if (res.records.length < PAGE) break;
    }
  } finally {
    await session.close();
  }
  return state;
}

/**
 * Replaces one workspace's graph with `state`: deletes its elements (and so its relationships),
 * then creates the given items with their stored versions and timestamps. Runs in batches, not
 * one transaction, so callers must keep writers out (the workspace lock) while it runs.
 */
export async function replaceWorkspaceGraph(
  sessions: SessionProvider,
  registry: MetamodelRegistry,
  workspaceId: string,
  state: ModelState,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<void> {
  const session = await sessions('WRITE');
  try {
    for (;;) {
      const res = await session.run('MATCH (n:Element) WHERE n.workspaceId = $ws WITH n LIMIT toInteger($page) DETACH DELETE n RETURN count(*) AS c', {
        ws: workspaceId,
        page: PAGE,
      });
      if (Number(res.records[0]?.get('c') ?? 0) === 0) break;
    }
    const elements = [...state.elements.values()];
    const relationships = [...state.relationships.values()];
    const total = elements.length + relationships.length;
    let done = 0;

    // Labels and relationship types cannot be parameters: group by them.
    const byLabels = group(elements, (e) => registry.labelsFor(e.type).map(ident).join(':'));
    for (const [labels, items] of byLabels) {
      for (const batch of chunks(items, PAGE)) {
        await session.run(`UNWIND $rows AS p CREATE (n:${labels}) SET n = p`, { rows: batch.map((e) => elementToProps(own(e, workspaceId))) });
        done += batch.length;
        await onProgress?.(done, total);
      }
    }
    for (const [type, items] of group(relationships, (r) => ident(r.type))) {
      for (const batch of chunks(items, PAGE)) {
        const res = await session.run(
          `UNWIND $rows AS row
           MATCH (a:Element {id: row.f}), (b:Element {id: row.o})
           WHERE a.workspaceId = $ws AND b.workspaceId = $ws
           CREATE (a)-[r:${type}]->(b) SET r = row.p RETURN count(r) AS c`,
          { ws: workspaceId, rows: batch.map((r) => ({ f: r.fromId, o: r.toId, p: relationshipToProps(own(r, workspaceId)) })) },
        );
        const created = Number(res.records[0]?.get('c') ?? 0);
        if (created !== batch.length) throw new Error(`${batch.length - created} ${type} relationships point at elements that are not in the workspace`);
        done += batch.length;
        await onProgress?.(done, total);
      }
    }
  } finally {
    await session.close();
  }
}

const own = <T extends Element | Relationship>(x: T, ws: string): T => {
  if (x.workspaceId !== ws) throw new Error(`${x.id} belongs to workspace ${x.workspaceId}, not ${ws}`);
  return x;
};

function group<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
