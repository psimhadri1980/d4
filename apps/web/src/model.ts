import { useQuery } from '@tanstack/react-query';
import { MetamodelRegistry, type AttributeDef } from '@d4/metamodel';
import { api } from './api';

/** The workspace metamodel as a registry: same rules the server enforces. */
export function useRegistry(ws: string | undefined) {
  return useQuery({
    queryKey: ['metamodel', ws],
    enabled: !!ws,
    staleTime: Infinity,
    queryFn: async () => new MetamodelRegistry(await api.metamodel(ws!)),
  });
}

/** One colour per layer, defined as CSS tokens in styles.css (`--layer-<name>`). */
export const layerVar = (layer: string | undefined) => `var(--layer-${(layer ?? 'other').toLowerCase()})`;

export function layerOf(reg: MetamodelRegistry, type: string): string {
  return reg.nodeType(type)?.layer ?? 'Other';
}

/** User-visible node types grouped by layer, in metamodel layer order. */
export function typesByLayer(reg: MetamodelRegistry): [string, string[]][] {
  return reg.metamodel.layers
    .map((layer) => [
      layer,
      reg
        .nodeTypes()
        .filter((t) => t.layer === layer && !t.internal)
        .map((t) => t.name)
        .sort(),
    ] as [string, string[]])
    .filter(([, types]) => types.length > 0);
}

/** Relationship types this element can start or end, with the allowed partner types. */
export function relationshipOptions(reg: MetamodelRegistry, elementType: string) {
  const lineage = reg.lineage(elementType);
  const visible = reg.nodeTypes().filter((t) => !t.internal);
  const out: { type: string; direction: 'OUT' | 'IN'; partnerTypes: string[] }[] = [];
  for (const r of reg.relationshipTypes()) {
    const fromOk = r.from.includes('*') || r.from.some((f) => lineage.includes(f));
    const toOk = r.to.includes('*') || r.to.some((t) => lineage.includes(t));
    if (fromOk) {
      out.push({
        type: r.name,
        direction: 'OUT',
        partnerTypes: visible.filter((t) => reg.canConnect(r.name, elementType, t.name)).map((t) => t.name),
      });
    }
    if (toOk) {
      out.push({
        type: r.name,
        direction: 'IN',
        partnerTypes: visible.filter((t) => reg.canConnect(r.name, t.name, elementType)).map((t) => t.name),
      });
    }
  }
  return out.filter((o) => o.partnerTypes.length > 0);
}

// ── Form values ↔ attribute values ──────────────────────────────────────

export type FormValues = Record<string, string | boolean>;

/** Attribute value → form field value (strings, booleans; lists as comma-separated text). */
export function toFormValue(def: AttributeDef, v: unknown): string | boolean {
  if (def.type === 'boolean') return v === true;
  if (v === undefined || v === null) return '';
  if (def.type === 'string[]') return Array.isArray(v) ? v.join(', ') : String(v);
  return String(v);
}

/**
 * Form field value → attribute value, or undefined when the field is empty. Invalid numbers are
 * passed through as text so the metamodel validator reports them.
 */
export function fromFormValue(def: AttributeDef, v: string | boolean): unknown {
  if (def.type === 'boolean') return v === true ? true : undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  switch (def.type) {
    case 'number':
    case 'integer':
      return Number.isNaN(Number(s)) ? s : Number(s);
    case 'string[]':
      return s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    default:
      return s;
  }
}

/** Builds attrs from a form; empty fields are left out. */
export function attrsFromForm(defs: AttributeDef[], values: FormValues): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const d of defs) {
    const v = fromFormValue(d, values[d.name] ?? '');
    if (v !== undefined) attrs[d.name] = v;
  }
  return attrs;
}

/** Changes for PATCH: set what changed, unset what was cleared. */
export function diffAttrs(before: Record<string, unknown>, after: Record<string, unknown>) {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(v)) set[k] = v;
  }
  for (const k of Object.keys(before)) if (!(k in after)) unset.push(k);
  return { set, unset };
}

export const elementName = (e: { attrs: Record<string, unknown>; id: string }) =>
  typeof e.attrs['name'] === 'string' ? (e.attrs['name'] as string) : e.id;
