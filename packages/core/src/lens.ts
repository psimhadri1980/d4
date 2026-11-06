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

export interface Lens {
  id: string;
  name: string;
  description?: string;
  contour: { type: string; attributes?: LensAttributeFilter[] };
  facets: LensFacet[];
  /** Every facet must hold, or any one of them. */
  match: 'all' | 'any';
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
  const n = lens.facets.length;
  return n ? `${lens.contour.type} · ${n} ${n === 1 ? 'facet' : 'facets'}` : lens.contour.type;
}

/** The criteria a lens fixes, as locked chips ("DataStore from lens", "Linked to Application from lens"). */
export function lensChips(lens: Lens): string[] {
  const attrs = (fs: LensAttributeFilter[] = []) => fs.map(describeFilter);
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

/** The Graph Studio search request for a lens (or none), the user's quick filters and name text. */
export function lensSearch(lens: Lens | null, quick: readonly QuickFilter[], name: string) {
  const strip = (q: QuickFilter): LensAttributeFilter => ({ attribute: q.attribute, op: q.op, value: q.value });
  return {
    types: lens ? [lens.contour.type] : undefined,
    name: name.trim() || undefined,
    attributes: [...(lens?.contour.attributes ?? []), ...quick.map(strip)],
    facets: lens?.facets ?? [],
    match: lens?.match ?? ('all' as const),
  };
}
