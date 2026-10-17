import type { ManagedTransaction, Session } from 'neo4j-driver';
import { relationshipIdIndexName } from '@d4/cypher';
import {
  DomainError,
  ULID_PATTERN,
  type ChangeSet,
  type DomainEvent,
  type Element,
  type ModelRepository,
  type Relationship,
} from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';
import {
  elementToProps,
  ident,
  propsToElement,
  propsToRelationship,
  relationshipToProps,
} from './mapping';

export type SessionProvider = (mode: 'READ' | 'WRITE') => Promise<Session>;

/**
 * Persists a command's events together with its graph write. Implementations open the event-log
 * transaction, append the events, run `write`, and commit the log only if `write` succeeded.
 */
export interface EventSink {
  withEvents(events: DomainEvent[], write: () => Promise<void>): Promise<void>;
}

type Row = Record<string, unknown>;

/** ModelRepository backed by a tenant's Neo4j database. */
export class Neo4jModelRepository implements ModelRepository {
  constructor(
    private readonly reg: MetamodelRegistry,
    private readonly sessions: SessionProvider,
    private readonly sink: EventSink,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────

  async getElement(ws: string, id: string): Promise<Element | undefined> {
    const [row] = await this.read(
      'MATCH (n:Element {id: $id}) WHERE n.workspaceId = $ws RETURN properties(n) AS p',
      { ws, id },
    );
    return row ? propsToElement(row['p'] as Row) : undefined;
  }

  async getRelationship(ws: string, id: string): Promise<Relationship | undefined> {
    const query = relationshipByIdQuery(this.reg, ws, id);
    if (!query) return undefined;
    const [row] = await this.read(query.cypher, query.params);
    return row ? toRelationship(row) : undefined;
  }

  async relationshipsOf(ws: string, elementId: string): Promise<Relationship[]> {
    const rows = await this.read(
      `MATCH (n:Element {id: $id})-[r]-()
       WHERE n.workspaceId = $ws AND r.workspaceId = $ws AND r.deleted = false
       RETURN DISTINCT properties(r) AS p, type(r) AS t, startNode(r).id AS f, endNode(r).id AS o`,
      { ws, id: elementId },
    );
    return rows.map(toRelationship);
  }

  async relationshipsTo(ws: string, type: string, toId: string): Promise<Relationship[]> {
    const rows = await this.read(
      `MATCH (a:Element)-[r:${ident(type)}]->(n:Element {id: $id})
       WHERE r.workspaceId = $ws AND r.deleted = false
       RETURN properties(r) AS p, type(r) AS t, a.id AS f, n.id AS o`,
      { ws, id: toId },
    );
    return rows.map(toRelationship);
  }

  async pathExists(ws: string, type: string, fromId: string, toId: string): Promise<boolean> {
    if (fromId === toId) return true;
    const rows = await this.read(
      `MATCH (a:Element {id: $from}), (b:Element {id: $to})
       WHERE a.workspaceId = $ws AND b.workspaceId = $ws
       MATCH p = shortestPath((a)-[:${ident(type)}*]->(b))
       WHERE all(r IN relationships(p) WHERE r.deleted = false)
       RETURN count(p) > 0 AS found`,
      { ws, from: fromId, to: toId },
    );
    return rows[0]?.['found'] === true;
  }

  // ── Writes ────────────────────────────────────────────────────────────

  async apply(ws: string, change: ChangeSet): Promise<void> {
    await this.sink.withEvents(change.events, async () => {
      const session = await this.sessions('WRITE');
      try {
        await session.executeWrite(async (tx) => {
          for (const e of change.elements) await this.writeElement(tx, ws, e);
          for (const r of change.relationships) await this.writeRelationship(tx, ws, r);
        });
      } finally {
        await session.close();
      }
    });
  }

  private async writeElement(tx: ManagedTransaction, ws: string, e: Element): Promise<void> {
    if (e.workspaceId !== ws) throw new Error(`element ${e.id} is not in workspace ${ws}`);
    const props = elementToProps(e);
    if (e.version === 1) {
      // The id uniqueness constraint rejects duplicates.
      const labels = this.reg.labelsFor(e.type).map(ident).join(':');
      await tx.run(`CREATE (n:${labels}) SET n = $props`, { props });
      return;
    }
    const res = await tx.run(
      `MATCH (n:Element {id: $id}) WHERE n.workspaceId = $ws AND n.version = $prev
       SET n = $props RETURN count(n) AS c`,
      { id: e.id, ws, prev: e.version - 1, props },
    );
    assertMatched(res.records[0]?.get('c'), e.id);
  }

  private async writeRelationship(tx: ManagedTransaction, ws: string, r: Relationship): Promise<void> {
    if (r.workspaceId !== ws) throw new Error(`relationship ${r.id} is not in workspace ${ws}`);
    const type = ident(r.type);
    const props = relationshipToProps(r);
    if (r.version === 1) {
      const res = await tx.run(
        `MATCH (a:Element {id: $from}), (b:Element {id: $to})
         WHERE a.workspaceId = $ws AND b.workspaceId = $ws AND a.deleted = false AND b.deleted = false
         CREATE (a)-[r:${type}]->(b) SET r = $props RETURN count(r) AS c`,
        { from: r.fromId, to: r.toId, ws, props },
      );
      assertMatched(res.records[0]?.get('c'), r.id);
      return;
    }
    const res = await tx.run(
      `MATCH ()-[r:${type} {id: $id}]->() WHERE r.workspaceId = $ws AND r.version = $prev
       SET r = $props RETURN count(r) AS c`,
      { id: r.id, ws, prev: r.version - 1, props },
    );
    assertMatched(res.records[0]?.get('c'), r.id);
  }

  private async read(cypher: string, params: Row): Promise<Row[]> {
    const session = await this.sessions('READ');
    try {
      const res = await session.executeRead((tx) => tx.run(cypher, params));
      return res.records.map((rec) => rec.toObject() as Row);
    } finally {
      await session.close();
    }
  }
}

/**
 * Cypher and parameters to find a relationship by id through the cross-type full-text id index
 * (see @d4/cypher). Returns undefined for values that cannot be ids. Yields p, t, f, o.
 */
export function relationshipByIdQuery(
  reg: MetamodelRegistry,
  ws: string,
  id: string,
): { cypher: string; params: Row } | undefined {
  if (!ULID_PATTERN.test(id) || !reg.relationshipTypes().length) return undefined;
  return {
    cypher: `CALL db.index.fulltext.queryRelationships($index, $q) YIELD relationship AS r
             WITH r WHERE r.id = $id AND r.workspaceId = $ws
             RETURN properties(r) AS p, type(r) AS t, startNode(r).id AS f, endNode(r).id AS o LIMIT 1`,
    params: { index: relationshipIdIndexName(reg), q: `"${id}"`, id, ws },
  };
}

export function toRelationship(row: Row): Relationship {
  return propsToRelationship(row['p'] as Row, row['t'] as string, row['f'] as string, row['o'] as string);
}

/** Zero matches means the stored version moved (or an endpoint vanished) since validation. */
function assertMatched(count: unknown, id: string): void {
  if (toNumber(count) !== 1) {
    throw new DomainError('VERSION_CONFLICT', `'${id}' changed concurrently`);
  }
}

/** Counts arrive as neo4j Integers unless the driver uses `disableLosslessIntegers`. */
export function toNumber(v: unknown): number {
  if (v && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return Number(v);
}
