/**
 * Graph Studio lenses (LS-1, LS-2): a lens is one contour (the node type every result is) and any
 * number of facets (node types linked to it that qualify it), plus a name and how the result opens.
 * A search always runs inside a lens, or across every type when the user is not sure yet (LS-3).
 */

export type AttributeOp = 'eq' | 'in' | 'contains' | 'starts' | 'gte' | 'lte';

export interface LensAttributeFilter {
  attribute: string;
  op: AttributeOp;
  value: string | number | boolean | (string | number | boolean)[];
}

export interface LensFacet {
  /** Node types at the other end; supertypes match their subtypes. */
  types: string[];
  /** Relationship type; any when absent. */
  relationship?: string;
  /** Seen from the contour: OUT is contour → facet. */
  direction: 'OUT' | 'IN' | 'BOTH';
  link: 'has' | 'none';
  attributes?: LensAttributeFilter[];
}

/**
 * A catalog query a lens takes its roots from (D84), instead of its contour and facets. The query
 * returns element ids in an `id` column, or element nodes.
 */
export interface LensQuery {
  /** The catalog entry. */
  id: string;
  /** A fixed published version; the latest published one when absent. */
  version?: number;
  /** The lens's values for the query's parameters; the query's defaults apply to the rest. */
  params?: Record<string, unknown>;
}

/** Relationship kinds a lens step can follow (D85); the metamodel declares each relationship's kind. */
export type LensRelationshipKind = 'containment' | 'dependency' | 'flow' | 'ownership' | 'association' | 'classification';

/**
 * One step of a lens's traversal (D85): which relationships to follow and which way. `down` follows
 * each relationship the way the metamodel reads it as down or downstream (container to part, source
 * to consumer), `up` the reverse. With neither `kind` nor `relationships`, any relationship.
 */
export interface LensStep {
  kind?: LensRelationshipKind;
  relationships?: string[];
  direction: 'down' | 'up' | 'both';
  /** Keep following this step, level after level. */
  repeat?: boolean;
}

/** How much a lens shows at first, and how the rest folds into groups that open on demand (D85). */
export interface LensDisclosure {
  /** Nodes drawn before the rest folds into groups. */
  budget: number;
  /** Levels opened at first. */
  initialDepth: number;
  /** A parent's links of one relationship and type fold into a group above this many. */
  perNodeCap: number;
}

/** The lens's shape: Ego (around the roots) or Hierarchy (a tree down from them). */
export type LensShape = 'ego' | 'tree';

export const LENS_DISCLOSURE: LensDisclosure = { budget: 150, initialDepth: 1, perNodeCap: 12 };
export const LENS_MAX_BUDGET = 350;

export interface Lens {
  id: string;
  name: string;
  description?: string;
  contour: { type: string; attributes?: LensAttributeFilter[] };
  facets: LensFacet[];
  /** Every facet must hold, or any one of them. */
  match: 'all' | 'any';
  /** Roots from a catalog query (D84); the contour then only says what type they are. */
  query?: LensQuery;
  /** Attributes offered as quick filters; the contour's pick-list attributes when absent. */
  quickFilters?: string[];
  /** The traversal (D85); absent means any relationship, both ways, to `depth`. */
  steps?: LensStep[];
  shape?: LensShape;
  disclosure?: Partial<LensDisclosure>;
  /** How the result opens (LS-6); the user can still change them on the canvas. */
  depth: number;
  layout: 'hier' | 'flow' | 'layers' | 'radial' | 'force';
  view: 'graph' | 'table';
  /** Keep the selected node centred (ZM-4). */
  follow?: boolean;
  /** Who sees it: only its owner, or everyone in the workspace. Built-in lenses have none. */
  visibility?: 'private' | 'workspace';
  /** The user id that saved it; absent for built-in lenses. */
  owner?: string;
}

/** What the user adds on top of a lens: they narrow it, never widen it (LS-4). */
export interface QuickFilter extends LensAttributeFilter {
  /** As shown on the chip, e.g. "Lifecycle LIVE". */
  label: string;
}

/** "DataProduct · 1 facet": the lens picker's short note. */
export function lensNote(lens: Lens): string {
  if (lens.query) return `${lens.contour.type} · catalog query`;
  const n = lens.facets.length;
  return n ? `${lens.contour.type} · ${n} ${n === 1 ? 'facet' : 'facets'}` : lens.contour.type;
}

/** The criteria a lens fixes, as locked chips ("DataStore from lens", "Linked to Application from lens"). */
export function lensChips(lens: Lens): string[] {
  const attrs = (fs: LensAttributeFilter[] = []) => fs.map(describeFilter);
  if (lens.query) return [`${lens.contour.type} from a catalog query`, ...attrs(lens.contour.attributes)];
  return [
    lens.contour.type,
    ...attrs(lens.contour.attributes),
    ...lens.facets.map((f) => {
      const rel = f.relationship ? ` by ${f.relationship.replace(/_/g, ' ')}` : '';
      const extra = f.attributes?.length ? ` (${attrs(f.attributes).join(', ')})` : '';
      return `${f.link === 'none' ? 'Not linked to' : 'Linked to'} ${f.types.join(' or ')}${rel}${extra}`;
    }),
  ];
}

const camel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

export function describeFilter(f: LensAttributeFilter): string {
  const label = camel(f.attribute);
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  const v = Array.isArray(f.value) ? f.value.join(' or ') : String(f.value);
  const op = { eq: '', in: '', contains: 'contains ', starts: 'starts with ', gte: 'at least ', lte: 'at most ' }[f.op];
  return `${name} ${op}${v}`;
}

/**
 * The Graph Studio search request for a lens (or none), the user's quick filters and name text.
 * `params` are the smart bar's values for a query lens's parameters, over the lens's own.
 */
export function lensSearch(lens: Lens | null, quick: readonly QuickFilter[], name: string, params?: Record<string, unknown>) {
  const strip = (q: QuickFilter): LensAttributeFilter => ({ attribute: q.attribute, op: q.op, value: q.value });
  const q = lens?.query;
  return {
    types: lens ? [lens.contour.type] : undefined,
    name: name.trim() || undefined,
    attributes: [...(lens?.contour.attributes ?? []), ...quick.map(strip)],
    // A query lens's roots are the query's; its facets do not apply.
    facets: q ? [] : (lens?.facets ?? []),
    match: lens?.match ?? ('all' as const),
    ...(q && { query: { id: q.id, ...(q.version && { version: q.version }), params: { ...q.params, ...params } } }),
  };
}

/** A lens's traversal, shape and disclosure (D85), with what older lenses imply filled in. */
export function lensSpec(lens: Lens | null): { steps: LensStep[]; shape: LensShape; disclosure: LensDisclosure } {
  const shape = lens?.shape ?? 'ego';
  const steps = lens?.steps?.length ? lens.steps : [{ direction: 'both' as const, repeat: true }];
  const d = { ...LENS_DISCLOSURE, ...(!lens?.steps?.length && lens?.depth ? { initialDepth: lens.depth } : {}), ...lens?.disclosure };
  return {
    shape,
    steps,
    disclosure: {
      budget: Math.min(Math.max(1, Math.trunc(d.budget)), LENS_MAX_BUDGET),
      initialDepth: Math.min(Math.max(1, Math.trunc(d.initialDepth)), 6),
      perNodeCap: Math.max(1, Math.trunc(d.perNodeCap)),
    },
  };
}

/** The step a traversal takes at `level` (0: from the roots), or none when it ends there. */
export function stepAt(steps: readonly LensStep[], level: number): LensStep | undefined {
  if (level < steps.length) return steps[level];
  const last = steps.at(-1);
  return last?.repeat ? last : undefined;
}

/**
 * Links folded into one group (D85): a parent's links of one relationship, one way, to one type.
 * Opening it loads its members a page at a time.
 */
export interface LensGroup {
  /** `parent~relationship~OUT or IN~type`, stable across loads. */
  id: string;
  parent: string;
  relationship: string;
  /** Seen from the parent. */
  direction: 'OUT' | 'IN';
  type: string;
  /** The level the members are on (the parent's + 1). */
  level: number;
  /** Members not yet shown. */
  count: number;
  /** Members already shown; the next page starts here. */
  offset: number;
}

export const groupId = (g: Pick<LensGroup, 'parent' | 'relationship' | 'direction' | 'type'>) => `${g.parent}~${g.relationship}~${g.direction}~${g.type}`;

/** "▸ 14 data stores", the label of a group. */
export function groupLabel(g: Pick<LensGroup, 'count' | 'type' | 'offset'>): string {
  const t = camel(g.type);
  return `▸ ${g.count}${g.offset ? ' more' : ''} ${g.count === 1 ? t : t.endsWith('s') ? t : t.endsWith('y') ? `${t.slice(0, -1)}ies` : `${t}s`}`;
}
