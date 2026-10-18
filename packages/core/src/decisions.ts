import type { Element, Relationship } from './types';

export interface DecisionRef {
  id: string;
  name: string;
  type: string;
  lifecycle: string | null;
}

/** One architecture decision record with what it decides, its options and its history. */
export interface DecisionRecord {
  id: string;
  name: string;
  status: string | null;
  decidedOn: string | null;
  context: string | null;
  consequences: string | null;
  lifecycle: string | null;
  decides: DecisionRef[];
  options: (DecisionRef & { chosen: boolean })[];
  supersedes: DecisionRef[];
  supersededBy: DecisionRef[];
  /** Problems worth a reviewer's attention (e.g. accepted without a chosen option). */
  findings: string[];
}

export const DECISION_RELATIONSHIPS = ['DECIDES', 'CONSIDERED', 'CHOSE', 'SUPERSEDES'];

const ref = (e: Element): DecisionRef => ({
  id: e.id,
  name: String(e.attrs['name'] ?? e.id),
  type: e.type,
  lifecycle: (e.attrs['lifecycle'] as string | undefined) ?? null,
});
const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));

/**
 * Builds the decision log from Decision elements and their DECIDES, CONSIDERED, CHOSE and
 * SUPERSEDES relationships. Newest decision first (by decidedOn, undated last).
 */
export function decisionLog(g: { elements: Element[]; relationships: Relationship[] }): DecisionRecord[] {
  const els = new Map(g.elements.map((e) => [e.id, e]));
  const out = (type: string, from: string) =>
    g.relationships.filter((r) => r.type === type && r.fromId === from && els.has(r.toId)).map((r) => els.get(r.toId)!);
  const into = (type: string, to: string) =>
    g.relationships.filter((r) => r.type === type && r.toId === to && els.has(r.fromId)).map((r) => els.get(r.fromId)!);

  const records = g.elements
    .filter((e) => e.type === 'Decision')
    .map((d): DecisionRecord => {
      const chosen = new Set(out('CHOSE', d.id).map((o) => o.id));
      const options = new Map<string, DecisionRef & { chosen: boolean }>();
      for (const o of [...out('CONSIDERED', d.id), ...out('CHOSE', d.id)]) options.set(o.id, { ...ref(o), chosen: chosen.has(o.id) });
      const status = str(d.attrs['status']);
      const supersededBy = into('SUPERSEDES', d.id).map(ref);
      const findings: string[] = [];
      if (status === 'ACCEPTED' && chosen.size === 0 && options.size > 0) findings.push('Accepted, but no option is marked as chosen');
      if (chosen.size > 1) findings.push(`${chosen.size} options are marked as chosen`);
      if (status === 'ACCEPTED' && !str(d.attrs['decidedOn'])) findings.push('Accepted without a decision date');
      if (supersededBy.length && status !== 'SUPERSEDED') findings.push(`Superseded by ${supersededBy.map((s) => s.name).join(', ')} but status is ${status ?? 'unset'}`);
      if (out('DECIDES', d.id).length === 0) findings.push('Not linked to any element it decides');
      return {
        id: d.id,
        name: String(d.attrs['name'] ?? d.id),
        status,
        decidedOn: str(d.attrs['decidedOn'])?.slice(0, 10) ?? null,
        context: str(d.attrs['context']),
        consequences: str(d.attrs['consequences']),
        lifecycle: str(d.attrs['lifecycle']),
        decides: out('DECIDES', d.id).map(ref).sort((a, b) => a.name.localeCompare(b.name)),
        options: [...options.values()].sort((a, b) => Number(b.chosen) - Number(a.chosen) || a.name.localeCompare(b.name)),
        supersedes: out('SUPERSEDES', d.id).map(ref),
        supersededBy,
        findings,
      };
    });
  // Descending by date; '' (undated) sorts after every date.
  return records.sort((a, b) => (b.decidedOn ?? '').localeCompare(a.decidedOn ?? '') || a.name.localeCompare(b.name));
}
