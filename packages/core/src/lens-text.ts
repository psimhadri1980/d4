import type { Lens, LensAttributeFilter, LensRelationshipKind, LensShape, LensStep } from './lens';

/**
 * The lens text form (D93), modelled on dbt selectors: one line that compiles to the same spec as
 * the editor.
 *
 *   [N+]Type[+M] [via kind | REL,REL] [to Type,Type] [where attr=v,attr=a|b,attr>=n,attr~text] [as shape]
 *
 * `N+` follows N levels up (upstream, towards containers), `+M` M levels down, both the same N both
 * ways. Without either the lens is drawn around its roots.
 */

export interface LensText {
  contour: { type: string; attributes: LensAttributeFilter[] };
  steps?: LensStep[];
  depth: number;
  shape?: LensShape;
}

export const LENS_TEXT_KINDS: readonly LensRelationshipKind[] = ['containment', 'dependency', 'flow', 'ownership', 'association', 'classification'];
const SHAPES: readonly LensShape[] = ['ego', 'tree', 'flow', 'matrix', 'landscape'];
const MAX_DEPTH = 6;

/** Reads the text form; the error says what is wrong in the words a user typed. */
export function parseLensText(text: string): { lens: LensText } | { error: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { error: 'Start with a node type, such as Application or 2+Application+2' };
  const head = /^(?:(\d+)\+)?([A-Z][A-Za-z0-9]*)(?:\+(\d+))?$/.exec(words[0]!);
  if (!head) return { error: `"${words[0]}" is not a node type with optional levels, such as 2+Application+2` };
  const [, up, type, down] = head;
  if (up && down && up !== down) return { error: 'Follow the same number of levels both ways, such as 2+Application+2' };
  const levels = Number(up ?? down ?? 0);
  if (levels > MAX_DEPTH) return { error: `At most ${MAX_DEPTH} levels` };
  if ((up || down) && levels < 1) return { error: 'Follow at least one level' };

  const out: LensText = { contour: { type: type!, attributes: [] }, depth: Math.max(levels, 1) };
  const step: LensStep | null = up || down ? { direction: up && down ? 'both' : up ? 'up' : 'down', repeat: true } : null;
  const seen = new Set<string>();
  for (let i = 1; i < words.length; i += 2) {
    const key = words[i]!.toLowerCase();
    const value = words[i + 1];
    if (!['via', 'to', 'where', 'as'].includes(key)) return { error: `"${words[i]}" is not via, to, where or as` };
    if (seen.has(key)) return { error: `"${key}" is given twice` };
    seen.add(key);
    if (!value) return { error: `Say what follows "${key}"` };
    if ((key === 'via' || key === 'to') && !step) return { error: `"${key}" needs levels to follow, such as ${type}+1` };
    if (key === 'via') {
      if ((LENS_TEXT_KINDS as readonly string[]).includes(value)) step!.kind = value as LensRelationshipKind;
      else if (/^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$/.test(value)) step!.relationships = value.split(',');
      else return { error: `"${value}" is not a relationship kind (${LENS_TEXT_KINDS.join(', ')}) or relationship names such as USES,REALIZES` };
    } else if (key === 'to') {
      if (!/^[A-Z][A-Za-z0-9]*(,[A-Z][A-Za-z0-9]*)*$/.test(value)) return { error: `"${value}" is not node types such as DataStore,DataSet` };
      step!.types = value.split(',');
    } else if (key === 'where') {
      for (const part of value.split(',')) {
        const f = filterOf(part);
        if (!f) return { error: `"${part}" is not a filter such as lifecycle=LIVE, criticality=HIGH|MEDIUM, score>=3 or name~pay` };
        out.contour.attributes.push(f);
      }
    } else {
      if (!(SHAPES as readonly string[]).includes(value)) return { error: `"${value}" is not a shape (${SHAPES.join(', ')})` };
      out.shape = value as LensShape;
    }
  }
  if (step) out.steps = [step];
  return { lens: out };
}

function filterOf(part: string): LensAttributeFilter | null {
  const m = /^([a-z][A-Za-z0-9]*)(>=|<=|=|~)(.+)$/.exec(part);
  if (!m) return null;
  const [, attribute, op, raw] = m as unknown as [string, string, string, string];
  const scalar = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);
  if (op === '>=' || op === '<=') return /^-?\d+(\.\d+)?$/.test(raw) ? { attribute, op: op === '>=' ? 'gte' : 'lte', value: Number(raw) } : null;
  if (op === '~') return { attribute, op: 'contains', value: raw };
  const values = raw.split('|');
  return values.length > 1 ? { attribute, op: 'in', value: values.map(scalar) } : { attribute, op: 'eq', value: scalar(raw) };
}

/**
 * A lens written in the text form, or null when it says more than the form can: facets, a catalog
 * query, more than one step, a step that stops or stages, or filters the form has no words for.
 */
export function formatLensText(lens: Pick<Lens, 'contour' | 'steps' | 'depth' | 'shape' | 'disclosure'> & { facets?: Lens['facets']; query?: Lens['query'] }): string | null {
  if (lens.query || lens.facets?.length || (lens.steps?.length ?? 0) > 1) return null;
  const step = lens.steps?.[0];
  if (step && (!step.repeat || step.stage || (step.kind && step.relationships?.length))) return null;
  const n = step ? (lens.disclosure?.initialDepth ?? lens.depth) : 0;
  const head = !step ? lens.contour.type : step.direction === 'up' ? `${n}+${lens.contour.type}` : step.direction === 'down' ? `${lens.contour.type}+${n}` : `${n}+${lens.contour.type}+${n}`;
  const parts = [head];
  if (step?.kind) parts.push(`via ${step.kind}`);
  else if (step?.relationships?.length) parts.push(`via ${step.relationships.join(',')}`);
  if (step?.types?.length) parts.push(`to ${step.types.join(',')}`);
  const filters: string[] = [];
  for (const f of lens.contour.attributes ?? []) {
    const v = Array.isArray(f.value) ? f.value : [f.value];
    if (v.some((x) => /[\s,|]/.test(String(x)))) return null;
    filters.push(
      f.op === 'eq' ? `${f.attribute}=${v[0]}` : f.op === 'in' ? `${f.attribute}=${v.join('|')}` : f.op === 'gte' ? `${f.attribute}>=${v[0]}` : f.op === 'lte' ? `${f.attribute}<=${v[0]}` : f.op === 'contains' ? `${f.attribute}~${v[0]}` : '',
    );
    if (!filters.at(-1)) return null;
  }
  if (filters.length) parts.push(`where ${filters.join(',')}`);
  if (lens.shape && lens.shape !== 'ego') parts.push(`as ${lens.shape}`);
  return parts.join(' ');
}
