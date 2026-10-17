import type { MetamodelRegistry } from '@d4/metamodel';
import { isLifecycleState } from './lifecycle';
import type { Element, Relationship } from './types';
import { overlaps, periodIssues } from './validity';

export interface ModelIssue {
  /** Element or relationship id the issue is about. */
  subjectId: string;
  /** Metamodel rule id, when the issue comes from a rule. */
  ruleId?: string;
  message: string;
}

export interface ModelSnapshot {
  elements: Element[];
  relationships: Relationship[];
}

/**
 * Validates a whole model at once (imports, model-as-code files, periodic integrity checks).
 * Unlike ModelService, which checks one change against stored state, this reports every issue.
 */
export function validateModel(reg: MetamodelRegistry, model: ModelSnapshot): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const elements = model.elements.filter((e) => !e.deleted);
  const relationships = model.relationships.filter((r) => !r.deleted);
  const byId = new Map(elements.map((e) => [e.id, e]));

  const seen = new Set<string>();
  for (const item of [...elements, ...relationships]) {
    if (seen.has(item.id)) issues.push({ subjectId: item.id, message: `duplicate id '${item.id}'` });
    seen.add(item.id);
  }

  for (const e of elements) {
    for (const m of [...reg.validateNodeAttributes(e.type, e.attrs), ...periodIssues(e)]) {
      issues.push({ subjectId: e.id, message: m });
    }
    if (e.attrs['lifecycle'] !== undefined && !isLifecycleState(e.attrs['lifecycle'])) {
      issues.push({ subjectId: e.id, message: `unknown lifecycle '${String(e.attrs['lifecycle'])}'` });
    }
  }

  for (const r of relationships) {
    const from = byId.get(r.fromId);
    const to = byId.get(r.toId);
    if (!from || !to) {
      issues.push({
        subjectId: r.id,
        message: `${r.type} references missing element '${!from ? r.fromId : r.toId}'`,
      });
      continue;
    }
    for (const m of [...reg.validateRelationship(r.type, from.type, to.type, r.attrs), ...periodIssues(r)]) {
      issues.push({ subjectId: r.id, message: m });
    }
  }

  for (const rule of reg.metamodel.rules) {
    const rels = relationships.filter((r) => r.type === rule.relationship);
    if (rule.kind === 'acyclic') {
      for (const cycle of findCycles(rels)) {
        issues.push({
          subjectId: cycle[0]!,
          ruleId: rule.id,
          message: `${rule.relationship} cycle: ${cycle.join(' → ')}`,
        });
      }
    } else {
      const groups = new Map<string, Relationship[]>();
      for (const r of rels) {
        const v = r.attrs[rule.attribute];
        if (typeof v !== 'string' || !rule.values.includes(v)) continue;
        const key = `${r.toId}|${v}|${r.scenarioId ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      for (const group of groups.values()) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const a = group[i]!;
            const b = group[j]!;
            if (overlaps(a, b)) {
              issues.push({
                subjectId: b.id,
                ruleId: rule.id,
                message: `${b.toId} has ${rule.attribute}=${String(b.attrs[rule.attribute])} from both ${a.fromId} and ${b.fromId} in overlapping periods`,
              });
            }
          }
        }
      }
    }
  }
  return issues;
}

/** One representative cycle per strongly connected loop found by DFS, as node id paths. */
function findCycles(rels: Relationship[]): string[][] {
  const next = new Map<string, string[]>();
  for (const r of rels) next.set(r.fromId, [...(next.get(r.fromId) ?? []), r.toId]);
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (n: string) => {
    state.set(n, 'visiting');
    stack.push(n);
    for (const m of next.get(n) ?? []) {
      const s = state.get(m);
      if (s === 'visiting') cycles.push([...stack.slice(stack.indexOf(m)), m]);
      else if (s === undefined) visit(m);
    }
    stack.pop();
    state.set(n, 'done');
  };
  for (const n of next.keys()) if (!state.has(n)) visit(n);
  return cycles;
}
