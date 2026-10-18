import type { Element, LifecycleCount, ModelSnapshot, ModelView, PlanningGraph, Relationship } from '@d4/core';
import { layerLabel, type MetamodelRegistry } from '@d4/metamodel';
import { ident, propsToElement, propsToRelationship } from './mapping';
import { relationshipByIdQuery, toNumber, toRelationship, type SessionProvider } from './repository';

type Row = Record<string, unknown>;

/**
 * Cypher predicate for "visible in the view" (see `visibleIn` in @d4/core): baseline items plus
 * the view's scenario, valid on `$asOf` when given. Parameters: `$asOf`, `$scenario`.
 */
export const inView = (x: string) =>
  `(${x}.scenarioId IS NULL OR ${x}.scenarioId = $scenario) AND ($asOf IS NULL OR ((${x}.validFrom IS NULL OR ${x}.validFrom <= $asOf) AND (${x}.validTo IS NULL OR $asOf < ${x}.validTo)))`;

/**
 * `inView` for a relationship, plus scenario replacement: a baseline relationship is hidden when
 * the view's scenario has a relationship of the same type between the same two elements.
 */
export const relInView = (r: string) =>
  `${inView(r)} AND NOT ($scenario IS NOT NULL AND ${r}.scenarioId IS NULL AND EXISTS {
     MATCH (rs)-[o]->(re) WHERE rs = startNode(${r}) AND re = endNode(${r})
       AND type(o) = type(${r}) AND o.scenarioId = $scenario AND o.deleted = false })`;
const viewParams = (v: ModelView = {}) => ({ asOf: v.asOf ?? null, scenario: v.scenarioId ?? null });

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
export const MAX_SCOPE_ROOTS = 50;
export const MAX_PLANNING_ITEMS = 2000;

/** Read-only queries backing the REST and GraphQL read endpoints. */
export class GraphQueries {
  constructor(
    private readonly reg: MetamodelRegistry,
    private readonly sessions: SessionProvider,
  ) {}

  async listElements(ws: string, filter: ElementFilter = {}, page: Page = {}, view: ModelView = {}): Promise<ElementPage> {
    const first = clamp(page.first ?? 50, 1, MAX_PAGE);
    const where = [
      'n.workspaceId = $ws',
      'n.deleted = false',
      '($types IS NULL OR any(l IN labels(n) WHERE l IN $types))',
      '($layer IS NULL OR $layer IN labels(n))',
      '($lifecycle IS NULL OR n.lifecycle IN $lifecycle)',
      inView('n'),
    ].join(' AND ');
    const params: Row = {
      ws,
      types: filter.types?.length ? filter.types.map((t) => this.knownType(t)) : null,
      layer: filter.layer ? layerLabel(filter.layer) : null,
      lifecycle: filter.lifecycle?.length ? filter.lifecycle : null,
      limit: first + 1,
      ...viewParams(view),
    };

    let cypher: string;
    if (filter.search?.trim()) {
      params['q'] = luceneQuery(filter.search);
      params['exact'] = filter.search.trim().toLowerCase();
      // An exact name match comes first; Lucene scores alone can rank a longer name above it.
      cypher = `CALL db.index.fulltext.queryNodes('element_search', $q) YIELD node AS n, score
                WHERE ${where}
                RETURN properties(n) AS p
                ORDER BY CASE WHEN toLower(n.name) = $exact THEN 0 ELSE 1 END, score DESC, n.id
                LIMIT toInteger($limit)`;
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
  async snapshot(ws: string, view?: ModelView): Promise<ModelSnapshot> {
    // Without a view: every live item, all scenarios and periods (export, import planning).
    const nv = view ? `AND ${inView('n')}` : '';
    const rv = view ? `AND ${relInView('r')} AND ${inView('a')} AND ${inView('b')}` : '';
    const params = { ws, ...viewParams(view) };
    const [elements, relationships] = await Promise.all([
      this.read(
        `MATCH (n:Element) WHERE n.workspaceId = $ws AND n.deleted = false ${nv} RETURN properties(n) AS p ORDER BY n.id`,
        params,
      ),
      this.read(
        `MATCH (a:Element)-[r]->(b:Element)
         WHERE a.workspaceId = $ws AND r.workspaceId = $ws AND r.deleted = false ${rv}
         RETURN properties(r) AS p, type(r) AS t, a.id AS f, b.id AS o ORDER BY r.id`,
        params,
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

  async connections(ws: string, id: string, filter: RelationshipFilter = {}, view: ModelView = {}): Promise<Connection[]> {
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
       WHERE r.deleted = false AND m.deleted = false AND ${relInView('r')} AND ${inView('m')}
       RETURN properties(r) AS rp, type(r) AS t, startNode(r).id AS f, endNode(r).id AS o, properties(m) AS mp
       ORDER BY t, m.name
       LIMIT 1000`,
      { ws, id, ...viewParams(view) },
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
    opts: { depth?: number; types?: string[]; limit?: number; view?: ModelView } = {},
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
         WHERE all(r IN rels WHERE r.deleted = false AND ${relInView('r')})
           AND all(x IN nodes(p) WHERE x.deleted = false AND ${inView('x')})
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
      { ws, id, limit, ...viewParams(opts.view) },
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

  /**
   * Relationships of the given types (with both ends) plus all elements of `elementTypes`, as
   * seen in a view: the input for matrices and the decision log. Capped at `max` relationships.
   */
  async subgraphOf(
    ws: string,
    relTypes: string[],
    elementTypes: string[] = [],
    view: ModelView = {},
    max = 20_000,
  ): Promise<{ elements: Element[]; relationships: Relationship[]; truncated: boolean }> {
    const rels = relTypes.map((t) => ident(this.knownRel(t)));
    const labels = elementTypes.map((t) => this.knownType(t));
    const params = { ws, labels, max: max + 1, ...viewParams(view) };
    const [relRows, elRows] = await Promise.all([
      rels.length
        ? this.read(
            `MATCH (a:Element)-[r:${rels.join('|')}]->(b:Element)
             WHERE a.workspaceId = $ws AND r.deleted = false AND a.deleted = false AND b.deleted = false
               AND ${relInView('r')} AND ${inView('a')} AND ${inView('b')}
             RETURN properties(r) AS p, type(r) AS t, a.id AS f, b.id AS o, properties(a) AS ap, properties(b) AS bp
             LIMIT toInteger($max)`,
            params,
          )
        : Promise.resolve([]),
      labels.length
        ? this.read(
            `MATCH (n:Element) WHERE n.workspaceId = $ws AND n.deleted = false
               AND any(l IN labels(n) WHERE l IN $labels) AND ${inView('n')}
             RETURN properties(n) AS p LIMIT toInteger($max)`,
            params,
          )
        : Promise.resolve([]),
    ]);
    const elements = new Map<string, Element>();
    for (const r of relRows) {
      for (const k of ['ap', 'bp']) {
        const e = propsToElement(r[k] as Row);
        elements.set(e.id, e);
      }
    }
    for (const r of elRows) {
      const e = propsToElement(r['p'] as Row);
      elements.set(e.id, e);
    }
    return {
      elements: [...elements.values()],
      relationships: relRows.slice(0, max).map((r) => propsToRelationship(r['p'] as Row, r['t'] as string, r['f'] as string, r['o'] as string)),
      truncated: relRows.length > max,
    };
  }

  /** Element counts per type and lifecycle state in a view (for the lifecycle heat-map). */
  async lifecycleCounts(ws: string, view: ModelView = {}): Promise<LifecycleCount[]> {
    const rows = await this.read(
      `MATCH (n:Element) WHERE n.workspaceId = $ws AND n.deleted = false AND ${inView('n')}
       RETURN n.type AS type, n.lifecycle AS lifecycle, count(*) AS count`,
      { ws, ...viewParams(view) },
    );
    return rows
      .filter((r) => this.reg.nodeType(r['type'] as string) && !this.reg.nodeType(r['type'] as string)!.internal)
      .map((r) => ({
        type: r['type'] as string,
        layer: this.reg.nodeType(r['type'] as string)!.layer,
        lifecycle: (r['lifecycle'] as string | null) ?? null,
        count: toNumber(r['count']),
      }));
  }

  /**
   * Planning items for a roadmap scope. Each root contributes:
   * - itself, if it is a deliverable or milestone;
   * - deliverables and milestones it OWNS or CONTAINS, transitively (division → initiative → deliverable);
   * - deliverables that CHANGE it, or CHANGE an element it OWNS;
   * - the milestones those deliverables are PART_OF.
   * Then the transitive DEPENDS_ON prerequisites of all of those, so the schedule is complete.
   */
  async planningGraph(ws: string, rootIds: string[]): Promise<PlanningGraph> {
    const roots = [...new Set(rootIds)].slice(0, MAX_SCOPE_ROOTS);
    const live = 'all(r IN relationships(p) WHERE r.deleted = false) AND all(x IN nodes(p) WHERE x.deleted = false)';
    const seeds = await this.read(
      `UNWIND $roots AS rid
       MATCH (root:Element {id: rid}) WHERE root.workspaceId = $ws AND root.deleted = false
       CALL {
         WITH root
         MATCH p = (root)-[:OWNS|CONTAINS*0..5]->(d:Element)
         WHERE (d:Deliverable OR d:Milestone) AND ${live}
         RETURN d
         UNION
         WITH root
         MATCH p = (d:Deliverable)-[:CHANGES]->(:Element)<-[:OWNS*0..1]-(root)
         WHERE ${live}
         RETURN d
       }
       WITH DISTINCT d
       CALL {
         WITH d
         RETURN d AS s
         UNION
         WITH d
         MATCH (d)-[r:PART_OF_MILESTONE]->(m:Milestone)
         WHERE r.deleted = false AND m.deleted = false
         RETURN m AS s
       }
       WITH DISTINCT s
       MATCH p = (s)-[:DEPENDS_ON*0..20]->(x:Element)
       WHERE ${live}
       RETURN DISTINCT x.id AS id
       LIMIT toInteger($max)`,
      { ws, roots, max: MAX_PLANNING_ITEMS },
    );
    const ids = seeds.map((r) => r['id'] as string);
    if (!ids.length) return { items: [], relationships: [], related: [] };

    const [items, rels] = await Promise.all([
      this.read(
        `MATCH (n:Element) WHERE n.id IN $ids AND n.workspaceId = $ws
         RETURN properties(n) AS p, CASE WHEN n:Milestone THEN 'milestone' ELSE 'deliverable' END AS kind
         ORDER BY n.id`,
        { ws, ids },
      ),
      this.read(
        `MATCH (n:Element) WHERE n.id IN $ids AND n.workspaceId = $ws
         MATCH (n)-[r:DEPENDS_ON|CHANGES|PART_OF_MILESTONE]->(m:Element)
         WHERE r.deleted = false AND m.deleted = false
         RETURN properties(r) AS p, type(r) AS t, n.id AS f, m.id AS o, properties(m) AS mp
         UNION ALL
         MATCH (n:Element) WHERE n.id IN $ids AND n.workspaceId = $ws
         MATCH (c:Element)-[r:CONTAINS]->(n)
         WHERE r.deleted = false AND c.deleted = false
         RETURN properties(r) AS p, type(r) AS t, c.id AS f, n.id AS o, properties(c) AS mp
         UNION ALL
         MATCH (n:Element) WHERE n.id IN $ids AND n.workspaceId = $ws
         OPTIONAL MATCH (c:Element)-[:CONTAINS]->(n) WHERE c.deleted = false
         WITH DISTINCT coalesce(c, n) AS owned
         MATCH (o:Element)-[r:OWNS]->(owned)
         WHERE r.deleted = false AND o.deleted = false
         RETURN properties(r) AS p, type(r) AS t, o.id AS f, owned.id AS o, properties(o) AS mp`,
        { ws, ids },
      ),
    ]);
    const related = new Map<string, Element>();
    for (const r of rels) {
      const e = propsToElement(r['mp'] as Row);
      related.set(e.id, e);
    }
    return {
      items: items.map((r) => ({ element: propsToElement(r['p'] as Row), kind: r['kind'] as 'deliverable' | 'milestone' })),
      relationships: rels.map((r) => propsToRelationship(r['p'] as Row, r['t'] as string, r['f'] as string, r['o'] as string)),
      related: [...related.values()],
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

/**
 * Turns free text into a safe Lucene query: escaped terms, each matched as a prefix, all required.
 * Hyphens and slashes separate terms, as the index's analyzer splits "cut-over" into "cut" and
 * "over"; a prefix query is not analyzed, so "cut-over*" would never match.
 */
export function luceneQuery(text: string): string {
  return text
    .trim()
    .split(/[\s\-/]+/)
    .filter(Boolean)
    .slice(0, 10)
    .map((term) => `+${term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&').toLowerCase()}*`)
    .join(' ');
}
