import type { AttributeDef, Metamodel } from './schema';

/**
 * Why a workspace on `from` cannot move to `to` without migrating its graph; empty means it can.
 * An upgrade may add types, relationships, attributes, endpoints, enum values and lens semantics
 * (kinds, direction, roles, importance), but never remove or change anything existing data
 * relies on: data valid under `from` stays valid under `to`.
 */
export function upgradeIssues(from: Metamodel, to: Metamodel): string[] {
  const issues: string[] = [];
  if (from.id !== to.id) issues.push(`${to.id} is not a version of ${from.id}`);
  if (from.version === to.version) issues.push(`already on ${from.id}@${from.version}`);

  for (const [name, values] of Object.entries(from.enums)) {
    const next = to.enums[name];
    if (!next) issues.push(`enum '${name}' is removed`);
    else for (const v of values) if (!next.includes(v)) issues.push(`enum '${name}' drops value '${v}'`);
  }
  attributes('common attributes', from.commonAttributes, to.commonAttributes, issues);

  const toTypes = new Map(to.nodeTypes.map((t) => [t.name, t]));
  for (const t of from.nodeTypes) {
    const next = toTypes.get(t.name);
    if (!next) {
      issues.push(`node type '${t.name}' is removed`);
      continue;
    }
    if (next.layer !== t.layer) issues.push(`node type '${t.name}' moves from layer '${t.layer}' to '${next.layer}'`);
    if (next.extends !== t.extends) issues.push(`node type '${t.name}' changes what it extends`);
    attributes(`node type '${t.name}'`, t.attributes, next.attributes, issues);
  }
  const toRels = new Map(to.relationshipTypes.map((r) => [r.name, r]));
  for (const r of from.relationshipTypes) {
    const next = toRels.get(r.name);
    if (!next) {
      issues.push(`relationship type '${r.name}' is removed`);
      continue;
    }
    ends(r.name, 'from', r.from, next.from, issues);
    ends(r.name, 'to', r.to, next.to, issues);
    attributes(`relationship type '${r.name}'`, r.attributes, next.attributes, issues);
  }

  // Existing data was never checked against a rule that is new or changed.
  const fromRules = new Map(from.rules.map((r) => [r.id, JSON.stringify(r)]));
  for (const r of to.rules) {
    const before = fromRules.get(r.id);
    if (before === undefined) issues.push(`rule '${r.id}' is new; existing data may break it`);
    else if (before !== JSON.stringify(r)) issues.push(`rule '${r.id}' changes`);
  }
  return issues;
}

function attributes(owner: string, from: AttributeDef[], to: AttributeDef[], issues: string[]) {
  const next = new Map(to.map((a) => [a.name, a]));
  for (const a of from) {
    const b = next.get(a.name);
    if (!b) issues.push(`${owner}: attribute '${a.name}' is removed`);
    else if (b.type !== a.type || b.enum !== a.enum) issues.push(`${owner}: attribute '${a.name}' changes type`);
    else if (b.required && !a.required) issues.push(`${owner}: attribute '${a.name}' becomes required`);
  }
  const known = new Set(from.map((a) => a.name));
  for (const b of to) if (b.required && !known.has(b.name)) issues.push(`${owner}: new attribute '${b.name}' is required`);
}

function ends(rel: string, side: 'from' | 'to', from: string[], to: string[], issues: string[]) {
  if (to.includes('*')) return;
  for (const e of from) if (!to.includes(e)) issues.push(`relationship type '${rel}' no longer allows '${e}' as '${side}'`);
}
