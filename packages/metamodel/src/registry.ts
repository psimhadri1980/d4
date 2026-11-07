import { RESERVED_ATTRIBUTE_NAMES, type AttributeDef, type Metamodel, type NodeTypeDef, type NodeTypeRole, type RelationshipKind, type RelationshipTypeDef } from './schema';

export type AttributeValues = Record<string, unknown>;

const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
/** What Neo4j can store as a property: a scalar or a list of scalars. */
const isPropertyValue = (v: unknown) => isScalar(v) || (Array.isArray(v) && v.every(isScalar));

export const layerLabel = (layer: string) => `${layer}Layer`;

/** Indexed, read-only view over a validated metamodel. */
export class MetamodelRegistry {
  private readonly nodes = new Map<string, NodeTypeDef>();
  private readonly rels = new Map<string, RelationshipTypeDef>();

  constructor(readonly metamodel: Metamodel) {
    for (const n of metamodel.nodeTypes) this.nodes.set(n.name, n);
    for (const r of metamodel.relationshipTypes) this.rels.set(r.name, r);
  }

  nodeType(name: string): NodeTypeDef | undefined {
    return this.nodes.get(name);
  }

  relationshipType(name: string): RelationshipTypeDef | undefined {
    return this.rels.get(name);
  }

  nodeTypes(): NodeTypeDef[] {
    return [...this.nodes.values()];
  }

  relationshipTypes(): RelationshipTypeDef[] {
    return [...this.rels.values()];
  }

  /** The type's lens role: its own, else the nearest ancestor's, else `both`. */
  roleOf(name: string): NodeTypeRole {
    for (const t of this.lineage(name)) {
      const role = this.nodes.get(t)?.role;
      if (role) return role;
    }
    return 'both';
  }

  /** A relationship type's kind (D85); `association` when the metamodel does not say. */
  kindOf(rel: string): RelationshipKind {
    return this.rels.get(rel)?.kind ?? 'association';
  }

  /** Whether the stored direction of `rel` reads as down / downstream (`out`) or the reverse. */
  forwardOf(rel: string): 'out' | 'in' {
    return this.rels.get(rel)?.forward ?? 'out';
  }

  /** The relationship types of a kind, by name. */
  relationshipsOfKind(kind: RelationshipKind): string[] {
    return this.relationshipTypes().filter((r) => (r.kind ?? 'association') === kind).map((r) => r.name).sort();
  }

  /** What makes a node of the type stand out: its own rule, else the nearest ancestor's. */
  importanceOf(name: string): { attribute: string; order: string[] } | undefined {
    for (const t of this.lineage(name)) {
      const imp = this.nodes.get(t)?.importance;
      if (imp) return imp;
    }
    return undefined;
  }

  /** The type itself followed by its ancestors via `extends`. */
  lineage(name: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(name);
    while (cur && !out.includes(cur.name)) {
      out.push(cur.name);
      cur = cur.extends ? this.nodes.get(cur.extends) : undefined;
    }
    return out;
  }

  /**
   * Neo4j labels for a node: Element, its layer label, its type and ancestor types.
   * Layer labels get a `Layer` suffix so they never collide with type labels (e.g. Application).
   */
  labelsFor(name: string): string[] {
    const t = this.nodes.get(name);
    if (!t) throw new Error(`unknown node type '${name}'`);
    return ['Element', layerLabel(t.layer), ...this.lineage(name)];
  }

  /** Common + inherited + own attributes; nearer definitions win. */
  attributesFor(name: string): AttributeDef[] {
    const byName = new Map<string, AttributeDef>();
    for (const a of this.metamodel.commonAttributes) byName.set(a.name, a);
    for (const t of this.lineage(name).reverse()) {
      for (const a of this.nodes.get(t)!.attributes) byName.set(a.name, a);
    }
    return [...byName.values()];
  }

  canConnect(rel: string, fromType: string, toType: string): boolean {
    const r = this.rels.get(rel);
    if (!r) return false;
    const matches = (ends: string[], type: string) =>
      ends.includes('*') || this.lineage(type).some((t) => ends.includes(t));
    return matches(r.from, fromType) && matches(r.to, toType);
  }

  validateNodeAttributes(type: string, values: AttributeValues): string[] {
    if (!this.nodes.has(type)) return [`unknown node type '${type}'`];
    return this.validateAttributes(type, this.attributesFor(type), values);
  }

  validateRelationship(
    rel: string,
    fromType: string,
    toType: string,
    values: AttributeValues = {},
  ): string[] {
    const r = this.rels.get(rel);
    if (!r) return [`unknown relationship type '${rel}'`];
    const issues: string[] = [];
    if (!this.canConnect(rel, fromType, toType)) {
      issues.push(`${rel} is not allowed from ${fromType} to ${toType}`);
    }
    return issues.concat(this.validateAttributes(rel, r.attributes, values));
  }

  private validateAttributes(owner: string, defs: AttributeDef[], values: AttributeValues): string[] {
    const issues: string[] = [];
    const known = new Map(defs.map((d) => [d.name, d]));
    for (const d of defs) {
      if (d.required && (values[d.name] === undefined || values[d.name] === null || values[d.name] === '')) {
        issues.push(`${owner}.${d.name} is required`);
      }
    }
    for (const [k, v] of Object.entries(values)) {
      const d = known.get(k);
      if (!d) {
        // Attributes the metamodel does not define are allowed, unless they clash with a system
        // field or hold a value Neo4j cannot store as a property.
        if (RESERVED_ATTRIBUTE_NAMES.has(k)) issues.push(`${owner}.${k} is a reserved name`);
        else if (v !== undefined && v !== null && !isPropertyValue(v)) {
          issues.push(`${owner}.${k} must be a string, number, boolean or a list of them`);
        }
        continue;
      }
      if (v === undefined || v === null) continue;
      const err = this.checkValue(d, v);
      if (err) issues.push(`${owner}.${k} ${err}`);
    }
    return issues;
  }

  private checkValue(d: AttributeDef, v: unknown): string | undefined {
    switch (d.type) {
      case 'string':
      case 'text':
        return typeof v === 'string' ? undefined : 'must be a string';
      case 'url':
        return typeof v === 'string' && URL.canParse(v) ? undefined : 'must be a URL';
      case 'number':
        return typeof v === 'number' && Number.isFinite(v) ? undefined : 'must be a number';
      case 'integer':
        return Number.isInteger(v) ? undefined : 'must be an integer';
      case 'boolean':
        return typeof v === 'boolean' ? undefined : 'must be a boolean';
      case 'date':
        return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v))
          ? undefined
          : 'must be a date (YYYY-MM-DD)';
      case 'datetime':
        return typeof v === 'string' && !isNaN(Date.parse(v)) ? undefined : 'must be an ISO datetime';
      case 'string[]':
        return Array.isArray(v) && v.every((x) => typeof x === 'string')
          ? undefined
          : 'must be a list of strings';
      case 'enum': {
        const allowed = this.metamodel.enums[d.enum!] ?? [];
        return typeof v === 'string' && allowed.includes(v)
          ? undefined
          : `must be one of ${allowed.join(', ')}`;
      }
    }
  }
}
