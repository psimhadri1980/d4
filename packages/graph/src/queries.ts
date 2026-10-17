import type { Element, ModelSnapshot, Relationship } from '@d4/core';
import { layerLabel, type MetamodelRegistry } from '@d4/metamodel';
import { ident, propsToElement, propsToRelationship } from './mapping';
import { relationshipByIdQuery, toRelationship, type SessionProvider } from './repository';

type Row = Record<string, unknown>;

export interface ElementFilter {
  /** Node types; supertypes match their subtypes (labels include ancestors). */
  types?: string[];
  layer?: string;
  lifecycle?: string[];
  /** Full-text search over name and description; results are ranked, not paged by cursor. */
  search?: string;
}

export interface Page {
  first?: number;
  /** Cursor from a previous page (the last element id; ULIDs sort by creation time). */
  after?: string;
}

export interface ElementPage {
  items: Element[];
  endCursor: string | null;
  hasMore: boolean;
}

export interface RelationshipFilter {
  direction?: 'OUT' | 'IN' | 'BOTH';
  types?: string[];
}

export interface Connection {
  relationship: Relationship;
  /** The element at the other end. */
  other: Element;
}

export interface Subgraph {
  root: Element;
  elements: Element[];
  relationships: Relationship[];
  /** True when `limit` cut the traversal short. */
  truncated: boolean;
}

export const MAX_PAGE = 200;
export const MAX_DEPTH = 3;

/** Read-only queries backing the REST and GraphQL read endpoints. */
export class GraphQueries {
  constructor(
    private readonly reg: MetamodelRegistry,
    private readonly sessions: SessionProvider,
  ) {}

  async listElements(ws: string, filter: ElementFilter = {}, page: Page = {}): Promise<ElementPage> {
    const first = clamp(page.first ?? 50, 1, MAX_PAGE);
    const where = [
      'n.workspaceId = $ws',
      'n.deleted = false',
      '($types IS NULL OR any(l IN labels(n) WHERE l IN $types))',
      '($layer IS NULL OR $layer IN labels(n))',
      '($lifecycle IS NULL OR n.lifecycle IN $lifecycle)',
    ].join(' AND ');
    const params: Row = {
      ws,
      types: filter.types?.length ? filter.types.map((t) => this.knownType(t)) : null,
      layer: filter.layer ? layerLabel(filter.layer) : null,
      lifecycle: filter.lifecycle?.length ? filter.lifecycle : null,
      limit: first + 1,
    };

    let cypher: string;
    if (filter.search?.trim()) {
      params['q'] = luceneQuery(filter.search);
      cypher = `CALL db.index.fulltext.queryNodes('element_search', $q) YIELD node AS n, score
                WHERE ${where}
                RETURN properties(n) AS p ORDER BY score DESC, n.id LIMIT toInteger($limit)`;
    } else {
      params['after'] = page.after ?? null;
      cypher = `MATCH (n:Element) WHERE ${where} AND ($after IS NULL OR n.id > $after)
                RETURN properties(n) AS p ORDER BY n.id LIMIT toInteger($limit)`;
    }
    const rows = await this.read(cypher, params);
    const items = rows.slice(0, first).map((r) => propsToElement(r['p'] as Row));
    const hasMore = rows.length > first;
    return { items, hasMore, endCursor: items.at(-1)?.id ?? null };
  }

  async getElement(ws: string, id: string): Promise<Element | undefined> {
    const [row] = await this.read(
      'MATCH (n:Element {id: $id}) WHERE n.workspaceId = $ws AND n.deleted = false RETURN properties(n) AS p',
      { ws, id },
    );
    return row ? propsToElement(row['p'] as Row) : undefined;
  }

  /** Every live element and relationship in the workspace (export, import planning). */
  async snapshot(ws: string): Promise<ModelSnapshot> {
    const [elements, relationships] = await Promise.all([
      this.read(
        'MATCH (n:Element) WHERE n.workspaceId = $ws AND n.deleted = false RETURN properties(n) AS p ORDER BY n.id',
        { ws },
      ),
      this.read(
        `MATCH (a:Element)-[r]->(b:Element)
         WHERE a.workspaceId = $ws AND r.workspaceId = $ws AND r.deleted = false
         RETURN properties(r) AS p, type(r) AS t, a.id AS f, b.id AS o ORDER BY r.id`,
        { ws },
      ),
    ]);
    return {
      elements: elements.map((row) => propsToElement(row['p'] as Row)),
      relationships: relationships.map(toRelationship),
    };
  }

  /** A live relationship by id. */
  async getRelationship(ws: string, id: string): Promise<Relationship | undefined> {
    const query = relationshipByIdQuery(this.reg, ws, id);
    if (!query) return undefined;
    const [row] = await this.read(query.cypher, query.params);
    const rel = row ? toRelationship(row) : undefined;
    return rel && !rel.deleted ? rel : undefined;
  }

  async connections(ws: string, id: string, filter: RelationshipFilter = {}): Promise<Connection[]> {
    const types = (filter.types ?? []).map((t) => ident(this.knownRel(t)));
    const typeExpr = types.length ? `:${types.join('|')}` : '';
    const pattern =
      filter.direction === 'OUT'
        ? `(n)-[r${typeExpr}]->(m)`
        : filter.direction === 'IN'
          ? `(n)<-[r${typeExpr}]-(m)`
          : `(n)-[r${typeExpr}]-(m)`;
    const rows = await this.read(
      `MATCH (n:Element {id: $id}) WHERE n.workspaceId = $ws
       MATCH ${pattern}
       WHERE r.deleted = false AND m.deleted = false
       RETURN properties(r) AS rp, type(r) AS t, startNode(r).id AS f, endNode(r).id AS o, properties(m) AS mp
       ORDER BY t, m.name
       LIMIT 1000`,
      { ws, id },
    );
    return rows.map((row) => ({
      relationship: propsToRelationship(row['rp'] as Row, row['t'] as string, row['f'] as string, row['o'] as string),
      other: propsToElement(row['mp'] as Row),
    }));
  }

  /** Elements and relationships within `depth` hops of the root, for the explorer canvas. */
  async neighbourhood(
    ws: string,
    id: string,
    opts: { depth?: number; types?: string[]; limit?: number } = {},
  ): Promise<Subgraph | undefined> {
    const depth = clamp(opts.depth ?? 1, 1, MAX_DEPTH);
    const limit = clamp(opts.limit ?? 500, 1, 2000);
    const types = (opts.types ?? []).map((t) => ident(this.knownRel(t)));
    const typeExpr = types.length ? `:${types.join('|')}` : '';
    // Depth must be a literal in variable-length patterns; it is a clamped integer.
    const rows = await this.read(
      `MATCH (root:Element {id: $id}) WHERE root.workspaceId = $ws AND root.deleted = false
       CALL {
         WITH root
         OPTIONAL MATCH p = (root)-[rels${typeExpr}*1..${depth}]-(m:Element)
         WHERE all(r IN rels WHERE r.deleted = false) AND all(x IN nodes(p) WHERE x.deleted = false)
         WITH p LIMIT toInteger($limit) + 1
         RETURN collect(p) AS paths
       }
       WITH root, paths, reduce(acc = [], p IN paths | acc + relationships(p)) AS allRels
       UNWIND (CASE WHEN size(allRels) = 0 THEN [null] ELSE allRels END) AS r
       WITH root, paths, collect(DISTINCT r) AS rs
       RETURN properties(root) AS root,
              size(paths) > toInteger($limit) AS truncated,
              [r IN rs | {p: properties(r), t: type(r), f: startNode(r).id, o: endNode(r).id}] AS rels,
              reduce(acc = [], r IN rs | acc + [properties(startNode(r)), properties(endNode(r))]) AS nodes`,
      { ws, id, limit },
    );
    const row = rows[0];
    if (!row) return undefined;

    const elements = new Map<string, Element>();
    for (const p of row['nodes'] as Row[]) {
      const e = propsToElement(p);
      elements.set(e.id, e);
    }
    const root = propsToElement(row['root'] as Row);
    elements.delete(root.id);
    return {
      root,
      elements: [...elements.values()],
      relationships: (row['rels'] as Row[]).map((r) =>
        propsToRelationship(r['p'] as Row, r['t'] as string, r['f'] as string, r['o'] as string),
      ),
      truncated: row['truncated'] === true,
    };
  }

  private knownType(t: string): string {
    if (!this.reg.nodeType(t)) throw new RangeError(`Unknown element type '${t}'`);
    return t;
  }

  private knownRel(t: string): string {
    if (!this.reg.relationshipType(t)) throw new RangeError(`Unknown relationship type '${t}'`);
    return t;
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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(n)));

/** Turns free text into a safe Lucene query: escaped terms, each matched as a prefix, all required. */
export function luceneQuery(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .map((term) => `+${term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&').toLowerCase()}*`)
    .join(' ');
}
