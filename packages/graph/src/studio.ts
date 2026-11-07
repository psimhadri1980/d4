import type { Element, ModelView, Relationship } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';
import { propsToElement, propsToRelationship } from './mapping';
import { inView, relInView, viewParams } from './queries';
import type { SessionProvider } from './repository';

type Row = Record<string, unknown>;

/**
 * Graph Studio reads: find the roots a lens matches, then load everything within `depth` hops of
 * them in both directions. Type, relationship and attribute names travel as parameters; the only
 * text spliced into Cypher is fixed fragments picked by enum values.
 */

export const STUDIO_MAX_DEPTH = 6;
export const STUDIO_MAX_NODES = 1000;
export const STUDIO_MAX_ROOTS = 500;
/** Relationship rows read per hop before the result counts as too large. */
const MAX_ROWS_PER_HOP = 20_000;

export type AttributeOp = 'eq' | 'in' | 'contains' | 'starts' | 'gte' | 'lte';

export interface AttributeFilter {
  attribute: string;
  op: AttributeOp;
  value: unknown;
}

export interface FacetFilter {
  /** Node types at the other end; supertypes match their subtypes. */
  types: readonly string[];
  /** Relationship type; any when absent. */
  relationship?: string;
  /** Seen from the contour node: OUT is (contour)-[r]->(facet). */
  direction: 'OUT' | 'IN' | 'BOTH';
  /** `has`: at least one such link; `none`: no such link. */
  link: 'has' | 'none';
  attributes?: AttributeFilter[];
}

export interface RootSearch {
  /** Exactly these elements (a drill-down); other filters still apply. */
  ids?: readonly string[];
  /** Contour types; any type when empty. */
  types?: readonly string[];
  /** Case-insensitive part of the name. */
  name?: string;
  attributes?: AttributeFilter[];
  facets?: FacetFilter[];
  /** Whether every facet must hold or any one of them. Default all. */
  match?: 'all' | 'any';
}

export interface StudioResult {
  roots: Element[];
  elements: Element[];
  relationships: Relationship[];
  /**
   * True when the roots or the expansion went past their limits. Nothing past the roots is
   * returned then: the Studio says the result is too large instead of drawing part of it.
   */
  tooLarge: boolean;
  /** Nodes found before stopping; a lower bound when `tooLarge`. */
  nodeCount: number;
}

const ATTRIBUTE_NAME = /^[a-z][A-Za-z0-9]*$/;

export interface StudioProfile {
  count: number;
  links: { relationship: string; direction: 'OUT' | 'IN'; type: string; count: number }[];
  /** Up to 13 values per attribute, most common first: 12 to offer as a pick-list, one to tell there are more. */
  values: Record<string, { value: unknown; count: number }[]>;
}

/**
 * The element ids a query lens's catalog query returned (D84): the `id` column's strings, else
 * every element node in the rows (as the catalog runner returns them), in order, without repeats.
 */
export function queryRootIds(result: { columns: readonly string[]; rows: readonly Record<string, unknown>[] }): string[] {
  const ids = new Set<string>();
  const node = (v: unknown) => {
    const p = (v as { labels?: unknown; properties?: { id?: unknown } } | null)?.properties;
    if (Array.isArray((v as { labels?: unknown })?.labels) && (v as { labels: string[] }).labels.includes('Element') && typeof p?.id === 'string') ids.add(p.id);
  };
  if (result.columns.includes('id')) {
    for (const r of result.rows) if (typeof r['id'] === 'string') ids.add(r['id']);
    return [...ids];
  }
  for (const r of result.rows) for (const v of Object.values(r)) (Array.isArray(v) ? v : [v]).forEach(node);
  return [...ids];
}

export class StudioQueries {
  constructor(
    private readonly reg: MetamodelRegistry,
    private readonly sessions: SessionProvider,
  ) {}

  /** Roots matching the search, then their neighbourhood to `depth` hops in both directions. */
  async search(
    ws: string,
    search: RootSearch,
    opts: { depth?: number; maxNodes?: number; view?: ModelView } = {},
  ): Promise<StudioResult> {
    const depth = clamp(opts.depth ?? 2, 1, STUDIO_MAX_DEPTH);
    const maxNodes = clamp(opts.maxNodes ?? STUDIO_MAX_NODES, 1, STUDIO_MAX_NODES);
    const found = await this.findRoots(ws, search, Math.min(maxNodes, STUDIO_MAX_ROOTS), opts.view);
    if (found.tooMany) return { roots: [], elements: [], relationships: [], tooLarge: true, nodeCount: found.roots.length };
    return { roots: found.roots, ...(await this.expand(ws, found.roots, depth, maxNodes, opts.view)) };
  }

  /** At most `limit` roots; `tooMany` when there are more. */
  async findRoots(ws: string, search: RootSearch, limit: number, view?: ModelView): Promise<{ roots: Element[]; tooMany: boolean }> {
    const { where, params } = this.rootWhere(ws, search, view);
    params['limit'] = limit + 1;
    const rows = await this.read(
      `MATCH (n:Element) WHERE ${where}
       RETURN properties(n) AS p ORDER BY toLower(coalesce(n.name, "")), n.id LIMIT toInteger($limit)`,
      params,
    );
    return { roots: rows.slice(0, limit).map((r) => propsToElement(r['p'] as Row)), tooMany: rows.length > limit };
  }

  /**
   * How many roots each search finds, counting at most `cap` (LS-5: the lens list's counts while
   * the user has not chosen a lens). Nothing is expanded, so this stays cheap.
   */
  async countRoots(ws: string, searches: readonly RootSearch[], cap: number, view?: ModelView, sample = 0): Promise<{ count: number; more: boolean; sample: string[] }[]> {
    return Promise.all(
      searches.map(async (search) => {
        const { where, params } = this.rootWhere(ws, search, view);
        params['cap'] = cap + 1;
        params['sample'] = sample;
        const rows = await this.read(
          `MATCH (n:Element) WHERE ${where} WITH n ORDER BY toLower(coalesce(n.name, "")), n.id LIMIT toInteger($cap)
           WITH collect(n) AS ns RETURN size(ns) AS c, [x IN ns[0..toInteger($sample)] | coalesce(x.name, x.id)] AS sample`,
          params,
        );
        const c = Number(rows[0]?.['c'] ?? 0);
        return { count: Math.min(c, cap), more: c > cap, sample: (rows[0]?.['sample'] as string[] | undefined) ?? [] };
      }),
    );
  }

  /**
   * What the lens editor offers for a contour type (LE-2, LE-3, LE-8): how many nodes of it there
   * are, the types linked to them (by relationship and direction, counting distinct contour
   * nodes), and for each asked attribute its most common values with their counts.
   */
  async profile(ws: string, type: string, attributes: readonly string[], view?: ModelView): Promise<StudioProfile> {
    const params: Row = { ws, types: [this.knownType(type)], ...viewParams(view) };
    const of = `MATCH (n:Element) WHERE n.workspaceId = $ws AND n.deleted = false AND any(l IN labels(n) WHERE l IN $types) AND ${inView('n')}`;
    const [countRows, linkRows, ...valueRows] = await Promise.all([
      this.read(`${of} RETURN count(n) AS c`, params),
      this.read(
        `${of}
         MATCH (n)-[r]-(m:Element) WHERE r.deleted = false AND m.deleted = false AND ${inView('m')} AND ${relInView('r')}
         RETURN type(r) AS rel, CASE WHEN startNode(r) = n THEN 'OUT' ELSE 'IN' END AS dir, m.type AS type, count(DISTINCT n) AS c
         ORDER BY c DESC, type, rel LIMIT 60`,
        params,
      ),
      ...attributes.map((a) => {
        if (!ATTRIBUTE_NAME.test(a)) throw new RangeError(`Invalid attribute name '${a}'`);
        return this.read(`${of} AND n[$k] IS NOT NULL RETURN n[$k] AS v, count(*) AS c ORDER BY c DESC LIMIT 13`, { ...params, k: a });
      }),
    ]);
    return {
      count: Number(countRows[0]?.['c'] ?? 0),
      links: linkRows.map((r) => ({ relationship: r['rel'] as string, direction: r['dir'] as 'OUT' | 'IN', type: r['type'] as string, count: Number(r['c']) })),
      values: Object.fromEntries(attributes.map((a, i) => [a, valueRows[i]!.map((r) => ({ value: r['v'] as unknown, count: Number(r['c']) }))])),
    };
  }

  private rootWhere(ws: string, search: RootSearch, view?: ModelView): { where: string; params: Row } {
    const params: Row = { ws, ...viewParams(view) };
    const where = ['n.workspaceId = $ws', 'n.deleted = false', inView('n')];
    if (search.ids?.length) {
      params['ids'] = [...search.ids];
      where.push('n.id IN $ids');
    }
    if (search.types?.length) {
      params['types'] = search.types.map((t) => this.knownType(t));
      where.push('any(l IN labels(n) WHERE l IN $types)');
    }
    if (search.name?.trim()) {
      params['name'] = search.name.trim().toLowerCase();
      where.push('toLower(coalesce(n.name, "")) CONTAINS $name');
    }
    where.push(...attributePredicates('n', 'a', search.attributes ?? [], params));
    const facets = (search.facets ?? []).map((f, i) => this.facetPredicate(f, `f${i}`, params));
    if (facets.length) where.push(`(${facets.join(search.match === 'any' ? ' OR ' : ' AND ')})`);
    return { where: where.join(' AND '), params };
  }

  /**
   * Breadth-first, one hop per query, so the cost is bounded by what is loaded rather than by the
   * number of paths (which explodes at depth 6). Stops as soon as `maxNodes` is passed.
   */
  async expand(
    ws: string,
    roots: Element[],
    depth: number,
    maxNodes: number,
    view?: ModelView,
  ): Promise<Omit<StudioResult, 'roots'>> {
    const nodes = new Map<string, Element>(roots.map((r) => [r.id, r]));
    const rels = new Map<string, Relationship>();
    const tooLarge = () => ({ elements: [], relationships: [], tooLarge: true, nodeCount: nodes.size });
    let frontier = roots.map((r) => r.id);

    for (let hop = 0; hop < depth && frontier.length; hop++) {
      const rows = await this.hop(ws, frontier, null, view);
      if (rows.length > MAX_ROWS_PER_HOP) return tooLarge();
      const next: string[] = [];
      for (const row of rows) {
        const rel = toRel(row);
        rels.set(rel.id, rel);
        const other = propsToElement(row['bp'] as Row);
        if (!nodes.has(other.id)) {
          nodes.set(other.id, other);
          next.push(other.id);
        }
      }
      if (nodes.size > maxNodes) return tooLarge();
      frontier = next;
    }
    // Links among the nodes reached on the last hop were not walked; add them.
    if (frontier.length) {
      for (const row of await this.hop(ws, frontier, [...nodes.keys()], view)) {
        const rel = toRel(row);
        rels.set(rel.id, rel);
      }
    }
    const rootIds = new Set(roots.map((r) => r.id));
    return {
      elements: [...nodes.values()].filter((e) => !rootIds.has(e.id)),
      relationships: [...rels.values()],
      tooLarge: false,
      nodeCount: nodes.size,
    };
  }

  /** Relationships touching `frontier`, with the node at the other end (limited to `within`). */
  private hop(ws: string, frontier: string[], within: string[] | null, view?: ModelView): Promise<Row[]> {
    return this.read(
      `MATCH (a:Element)-[r]-(b:Element)
       WHERE a.id IN $frontier AND a.workspaceId = $ws AND b.deleted = false AND r.deleted = false
         AND ($within IS NULL OR b.id IN $within)
         AND ${inView('b')} AND ${relInView('r')}
       RETURN properties(r) AS p, type(r) AS t, startNode(r).id AS f, endNode(r).id AS o, properties(b) AS bp
       LIMIT toInteger($limit)`,
      { ws, frontier, within, limit: MAX_ROWS_PER_HOP + 1, ...viewParams(view) },
    );
  }

  private facetPredicate(f: FacetFilter, key: string, params: Row): string {
    params[`${key}t`] = f.types.map((t) => this.knownType(t));
    const conds = [
      'm.deleted = false',
      'r.deleted = false',
      `any(l IN labels(m) WHERE l IN $${key}t)`,
      inView('m'),
      relInView('r'),
    ];
    if (f.relationship) {
      params[`${key}r`] = this.knownRel(f.relationship);
      conds.push(`type(r) = $${key}r`);
    }
    conds.push(...attributePredicates('m', `${key}a`, f.attributes ?? [], params));
    const pattern = { OUT: '(n)-[r]->(m:Element)', IN: '(n)<-[r]-(m:Element)', BOTH: '(n)-[r]-(m:Element)' }[f.direction];
    const exists = `EXISTS { MATCH ${pattern} WHERE ${conds.join(' AND ')} }`;
    return f.link === 'none' ? `NOT ${exists}` : exists;
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

/**
 * Predicates on `x`'s attributes. Names are checked and passed as parameters (`x[$k]`), so any
 * attribute, defined in the metamodel or not, can be filtered on.
 */
export function attributePredicates(x: string, prefix: string, filters: AttributeFilter[], params: Row): string[] {
  return filters.map((f, i) => {
    if (!ATTRIBUTE_NAME.test(f.attribute)) throw new RangeError(`Invalid attribute name '${f.attribute}'`);
    const k = `${prefix}${i}k`;
    const v = `${prefix}${i}v`;
    params[k] = f.attribute;
    params[v] = f.op === 'contains' || f.op === 'starts' ? String(f.value).toLowerCase() : f.value;
    switch (f.op) {
      case 'eq':
        return `${x}[$${k}] = $${v}`;
      case 'in':
        if (!Array.isArray(f.value)) throw new RangeError(`'in' on '${f.attribute}' needs a list`);
        return `${x}[$${k}] IN $${v}`;
      case 'contains':
        return `toLower(toString(${x}[$${k}])) CONTAINS $${v}`;
      case 'starts':
        return `toLower(toString(${x}[$${k}])) STARTS WITH $${v}`;
      case 'gte':
        return `${x}[$${k}] >= $${v}`;
      case 'lte':
        return `${x}[$${k}] <= $${v}`;
    }
  });
}

const toRel = (row: Row) => propsToRelationship(row['p'] as Row, row['t'] as string, row['f'] as string, row['o'] as string);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(n)));
