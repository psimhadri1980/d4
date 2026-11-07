import { groupId, stepAt, type Element, type LensDisclosure, type LensGroup, type LensStep, type ModelView, type Relationship } from '@d4/core';
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

/**
 * A lens result drawn by disclosure (D85): the roots and what fits the budget, with the rest folded
 * into groups the user opens. Nothing is cut without a group or `truncated` saying so.
 */
export interface StudioProjection {
  roots: Element[];
  elements: Element[];
  relationships: Relationship[];
  groups: LensGroup[];
  /** Each shown node's level: 0 for the roots. */
  levels: Record<string, number>;
  /** A step read more rows than allowed, so some links are missing. */
  truncated: boolean;
}

/** A page of a group's members, with their own folded links one level further. */
export interface StudioGroupPage {
  elements: Element[];
  relationships: Relationship[];
  groups: LensGroup[];
  levels: Record<string, number>;
  /** The group with what is left in it; count 0 when it is used up. */
  group: LensGroup;
  truncated: boolean;
}

/** Impact table limits (D88): nodes listed and levels walked. */
export const IMPACT_MAX_NODES = 5000;
export const IMPACT_MAX_LEVELS = 20;

/** One node a lens reaches, for the impact table: its level and the link that first reached it. */
export interface StudioImpactRow {
  element: Element;
  level: number;
  relationship: string;
  /** Seen from `from`. */
  direction: 'OUT' | 'IN';
  from: string;
  fromName: string;
}

export interface StudioImpact {
  rows: StudioImpactRow[];
  truncated: boolean;
}

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

  /**
   * The lens result by disclosure (D85). Level by level from the roots, along the lens's steps: a
   * parent's links of one relationship and type are shown when they fit the per-node cap and the
   * budget, else they fold into a group. Nodes on the last level opened get their next step as
   * groups with counts, so every branch that goes on says how much is there.
   */
  async project(ws: string, roots: Element[], steps: readonly LensStep[], d: LensDisclosure, view?: ModelView): Promise<StudioProjection> {
    const out: StudioProjection = { roots, elements: [], relationships: [], groups: [], levels: {}, truncated: false };
    const shown = new Map<string, Element>(roots.map((r) => [r.id, r]));
    for (const r of roots) out.levels[r.id] = 0;
    const rels = new Map<string, Relationship>();
    let frontier = roots.map((r) => r.id);
    let level = 0;
    for (; level < d.initialDepth && frontier.length; level++) {
      const step = stepAt(steps, level);
      if (!step) { frontier = []; break; }
      const { rows, truncated } = await this.stepRows(ws, frontier, step, null, view);
      out.truncated ||= truncated;
      const next: string[] = [];
      // Parents in the order they are shown, so the first ones get the budget.
      const order = new Map(frontier.map((id, i) => [id, i]));
      const byGroup = groupRows(rows);
      const keys = [...byGroup.keys()].sort((a, b) => order.get(byGroup.get(a)![0]!.parent)! - order.get(byGroup.get(b)![0]!.parent)! || a.localeCompare(b));
      for (const key of keys) {
        const members = byGroup.get(key)!;
        const fresh = members.filter((m) => !shown.has(m.node.id));
        // Links to nodes already shown are drawn; they cost no budget.
        for (const m of members) if (shown.has(m.node.id)) rels.set(m.rel.id, m.rel);
        if (!fresh.length) continue;
        if (fresh.length <= d.perNodeCap && shown.size + fresh.length <= d.budget) {
          for (const m of this.ranked(fresh)) {
            shown.set(m.node.id, m.node);
            out.levels[m.node.id] = level + 1;
            rels.set(m.rel.id, m.rel);
            next.push(m.node.id);
          }
        } else {
          const g = members[0]!;
          out.groups.push({ id: groupId(g), parent: g.parent, relationship: g.relationship, direction: g.direction, type: g.type, level: level + 1, count: fresh.length, offset: 0 });
        }
      }
      frontier = next;
    }
    const tail = await this.unfoldSingles(ws, await this.groupCounts(ws, frontier, steps, level, [...shown.keys()], view), steps, new Set(shown.keys()), d.budget - shown.size, view);
    for (const m of tail.rows) {
      shown.set(m.node.id, m.node);
      rels.set(m.rel.id, m.rel);
    }
    for (const r of tail.links) rels.set(r.id, r);
    Object.assign(out.levels, tail.levels);
    out.truncated ||= tail.truncated;
    out.groups.push(...tail.groups);
    out.elements = [...shown.values()].filter((e) => out.levels[e.id] !== 0);
    out.relationships = [...rels.values()];
    return out;
  }

  /** The next page of a group (D85): its members ranked by importance, and their own groups. */
  async openGroup(ws: string, group: LensGroup, steps: readonly LensStep[], d: LensDisclosure, shownIds: readonly string[], view?: ModelView): Promise<StudioGroupPage> {
    const step: LensStep = { relationships: [group.relationship], direction: 'both' };
    const { rows, truncated } = await this.stepRows(ws, [group.parent], step, null, view);
    const shown = new Set(shownIds);
    const members = this.ranked(rows.filter((m) => m.relationship === group.relationship && m.direction === group.direction && m.type === group.type && !shown.has(m.node.id)));
    // A page never leaves a group of one behind: the last member comes along.
    const page = members.slice(0, members.length === d.perNodeCap + 1 ? members.length : d.perNodeCap);
    const levels = Object.fromEntries(page.map((m) => [m.node.id, group.level]));
    const ids = page.map((m) => m.node.id);
    const all = new Set([...shown, ...ids]);
    const tail = await this.unfoldSingles(ws, await this.groupCounts(ws, ids, steps, group.level, [...all], view), steps, all, d.budget - all.size, view);
    return {
      elements: [...page, ...tail.rows].map((m) => m.node),
      relationships: [...[...page, ...tail.rows].map((m) => m.rel), ...tail.links],
      groups: tail.groups,
      levels: { ...levels, ...tail.levels },
      group: { ...group, count: members.length - page.length, offset: group.offset + page.length },
      truncated: truncated || tail.truncated,
    };
  }

  /**
   * Everything a lens reaches from the roots, without a budget (D88: the impact table). Level by
   * level along the steps, each node once, at the level it is first reached and through the first
   * link that reached it. Stops at `maxNodes` or `maxLevels` with `truncated`.
   */
  async impact(ws: string, roots: Element[], steps: readonly LensStep[], opts: { maxNodes?: number; maxLevels?: number; view?: ModelView } = {}): Promise<StudioImpact> {
    const maxNodes = clamp(opts.maxNodes ?? IMPACT_MAX_NODES, 1, IMPACT_MAX_NODES);
    const maxLevels = clamp(opts.maxLevels ?? IMPACT_MAX_LEVELS, 1, IMPACT_MAX_LEVELS);
    const seen = new Set(roots.map((r) => r.id));
    const names = new Map(roots.map((r) => [r.id, name(r)]));
    const rows: StudioImpactRow[] = [];
    let frontier = roots.map((r) => r.id);
    let truncated = false;
    for (let level = 0; level < maxLevels && frontier.length; level++) {
      const step = stepAt(steps, level);
      if (!step) break;
      const read = await this.stepRows(ws, frontier, step, null, opts.view);
      truncated ||= read.truncated;
      const next: string[] = [];
      for (const m of read.rows) {
        if (seen.has(m.node.id)) continue;
        if (seen.size - roots.length >= maxNodes) {
          truncated = true;
          break;
        }
        seen.add(m.node.id);
        names.set(m.node.id, name(m.node));
        rows.push({ element: m.node, level: level + 1, relationship: m.relationship, direction: m.direction, from: m.parent, fromName: names.get(m.parent) ?? '' });
        next.push(m.node.id);
      }
      frontier = next;
      // A repeated step that still finds nodes at the level cap was cut short.
      if (level === maxLevels - 1 && frontier.length && stepAt(steps, level + 1)) truncated = true;
    }
    return { rows, truncated };
  }

  /**
   * A group of one is its member: drawn as the node, with its own next step counted, while the
   * budget has room. Only one level past the last one opened, so a deeper Depth never shows less.
   */
  private async unfoldSingles(ws: string, groups: LensGroup[], steps: readonly LensStep[], shown: Set<string>, room: number, view?: ModelView) {
    const rows: StepRow[] = [];
    const links: Relationship[] = [];
    const levels: Record<string, number> = {};
    const singles = groups.filter((g) => g.count === 1).slice(0, Math.max(room, 0));
    if (!singles.length) return { groups, rows, links, levels, truncated: false };
    const byId = new Map(singles.map((g) => [g.id, g]));
    const step: LensStep = { relationships: [...new Set(singles.map((g) => g.relationship))], direction: 'both' };
    const read = await this.stepRows(ws, [...new Set(singles.map((g) => g.parent))], step, null, view);
    const added = new Map<number, string[]>();
    for (const m of read.rows) {
      const g = byId.get(groupId(m));
      if (!g) continue;
      // Two singles can lead to the same node: it is drawn once, with both links.
      if (shown.has(m.node.id)) {
        links.push(m.rel);
        continue;
      }
      shown.add(m.node.id);
      levels[m.node.id] = g.level;
      rows.push(m);
      added.set(g.level, [...(added.get(g.level) ?? []), m.node.id]);
    }
    const rest = groups.filter((g) => !byId.has(g.id));
    for (const [level, ids] of added) rest.push(...(await this.groupCounts(ws, ids, steps, level, [...shown], view)));
    return { groups: rest, rows, links, levels, truncated: read.truncated };
  }

  /** Groups with counts for the step after `level`, from each of `parents`, leaving out what is shown. */
  private async groupCounts(ws: string, parents: string[], steps: readonly LensStep[], level: number, shownIds: string[], view?: ModelView): Promise<LensGroup[]> {
    const step = stepAt(steps, level);
    if (!step || !parents.length) return [];
    const { where, params } = this.stepWhere(step);
    const rows = await this.read(
      `MATCH (a:Element)-[r]-(b:Element)
       WHERE a.id IN $frontier AND a.workspaceId = $ws AND b.deleted = false AND r.deleted = false AND NOT b.id IN $shown
         AND ${where} AND ${inView('b')} AND ${relInView('r')}
       RETURN a.id AS parent, type(r) AS t, CASE WHEN startNode(r) = a THEN 'OUT' ELSE 'IN' END AS d, b.type AS bt, count(DISTINCT b) AS c
       ORDER BY parent, t, d, bt`,
      { ...params, ws, frontier: parents, shown: shownIds, ...viewParams(view) },
    );
    return rows.map((r) => {
      const g = { parent: r['parent'] as string, relationship: r['t'] as string, direction: r['d'] as 'OUT' | 'IN', type: r['bt'] as string };
      return { ...g, id: groupId(g), level: level + 1, count: Number(r['c']), offset: 0 };
    });
  }

  /** Relationships a step follows from each of `frontier`, with the node at the other end. */
  private async stepRows(ws: string, frontier: string[], step: LensStep, within: string[] | null, view?: ModelView): Promise<{ rows: StepRow[]; truncated: boolean }> {
    const { where, params } = this.stepWhere(step);
    const rows = await this.read(
      `MATCH (a:Element)-[r]-(b:Element)
       WHERE a.id IN $frontier AND a.workspaceId = $ws AND b.deleted = false AND r.deleted = false
         AND ($within IS NULL OR b.id IN $within) AND ${where}
         AND ${inView('b')} AND ${relInView('r')}
       RETURN a.id AS parent, properties(r) AS p, type(r) AS t, startNode(r).id AS f, endNode(r).id AS o, properties(b) AS bp
       LIMIT toInteger($limit)`,
      { ...params, ws, frontier, within, limit: MAX_ROWS_PER_HOP + 1, ...viewParams(view) },
    );
    const parsed = rows.slice(0, MAX_ROWS_PER_HOP).map((row): StepRow => {
      const rel = toRel(row);
      const parent = row['parent'] as string;
      const node = propsToElement(row['bp'] as Row);
      return { parent, rel, node, relationship: rel.type, direction: rel.fromId === parent ? 'OUT' : 'IN', type: node.type };
    });
    return { rows: parsed, truncated: rows.length > MAX_ROWS_PER_HOP };
  }

  /**
   * Which links a step follows, as a predicate on `a` (the node it starts from) and `r`. `down`
   * follows a relationship whose metamodel direction is `out` from start to end, one that is `in`
   * from end to start; `up` the reverse.
   */
  private stepWhere(step: LensStep): { where: string; params: Row } {
    const names = step.relationships?.length ? step.relationships.map((r) => this.knownRel(r)) : step.kind ? this.reg.relationshipsOfKind(step.kind) : null;
    // A step may only go to some types (a viewpoint chain's next stage).
    const to = step.types?.length ? step.types.map((t) => this.knownType(t)) : null;
    const target = '($to IS NULL OR any(l IN labels(b) WHERE l IN $to))';
    if (step.direction === 'both') return { where: `($rels IS NULL OR type(r) IN $rels) AND ${target}`, params: { rels: names, to } };
    const all = names ?? this.reg.relationshipTypes().map((r) => r.name);
    const fwd = all.filter((n) => this.reg.forwardOf(n) === 'out');
    const rev = all.filter((n) => this.reg.forwardOf(n) === 'in');
    const [out, inn] = step.direction === 'down' ? [fwd, rev] : [rev, fwd];
    return { where: `((startNode(r) = a AND type(r) IN $out) OR (endNode(r) = a AND type(r) IN $in)) AND ${target}`, params: { out, in: inn, to } };
  }

  /** Most important first (the type's importance rule in the metamodel), then by name. */
  private ranked<T extends { node: Element }>(xs: T[]): T[] {
    const rank = (e: Element) => {
      const imp = this.reg.importanceOf(e.type);
      const i = imp ? imp.order.indexOf(String(e.attrs[imp.attribute] ?? '')) : -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...xs].sort((a, b) => rank(a.node) - rank(b.node) || name(a.node).localeCompare(name(b.node)) || a.node.id.localeCompare(b.node.id));
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

interface StepRow {
  parent: string;
  rel: Relationship;
  node: Element;
  relationship: string;
  direction: 'OUT' | 'IN';
  type: string;
}

/** Rows by group (parent, relationship, direction, type), in the order first seen. */
function groupRows(rows: StepRow[]): Map<string, StepRow[]> {
  const out = new Map<string, StepRow[]>();
  for (const r of rows) {
    const k = groupId(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

const name = (e: Element) => String(e.attrs['name'] ?? '');
const toRel = (row: Row) => propsToRelationship(row['p'] as Row, row['t'] as string, row['f'] as string, row['o'] as string);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(n)));
