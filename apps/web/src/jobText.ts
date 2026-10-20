import type { Job } from './api';

/** Plain-language descriptions of jobs, shared by the Jobs page and Admin backups. */
const BACKUP_KINDS: Record<string, string> = {
  backup: 'Back up the graph',
  verify: 'Check the graph against the event log',
  restore: 'Restore the graph from a backup',
  rebuild: 'Rebuild the graph from the event log',
};

export function describe(j: Job): string {
  if (BACKUP_KINDS[j.kind]) return BACKUP_KINDS[j.kind]!;
  if (j.kind === 'render') return `Picture (${String(j.params['format']).toUpperCase()}) of ${j.params['target'] === 'roadmap' ? 'a roadmap' : 'a graph'}`;
  if (j.kind === 'export') {
    const p = j.params;
    const bits = [String(p['format'] ?? 'yaml'), p['scope'] ? 'of a graph' : 'of the workspace', p['asOf'] ? `as of ${String(p['asOf'])}` : '', p['scenario'] ? 'in a scenario' : ''];
    return `Export ${bits.filter(Boolean).join(' ')}`;
  }
  const files = (j.params['files'] as string[] | undefined) ?? [];
  return `${j.params['dryRun'] ? 'Check' : 'Import'} ${files.join(', ')}`;
}

export function outcome(j: Job): string {
  if (j.status === 'failed') return j.error ?? 'Failed';
  if (j.status !== 'succeeded' || !j.result) return '';
  if (BACKUP_KINDS[j.kind]) {
    const b = j.result as { elements?: number; relationships?: number; matches?: boolean; differences?: number; eventsReplayed?: number };
    if (j.kind === 'verify') return b.matches ? `Matches the event log (${String(b.elements)} elements, ${String(b.relationships)} relationships)` : `${String(b.differences)} differences from the event log`;
    const counts = `${String(b.elements)} elements, ${String(b.relationships)} relationships`;
    return j.kind === 'backup' ? `Saved: ${counts}` : `Replaced: ${counts}${b.eventsReplayed !== undefined ? `, ${b.eventsReplayed} events replayed` : ''}`;
  }
  interface Counts {
    created?: number;
    updated?: number;
  }
  const r = j.result as { elements?: Counts | number; relationships?: Counts | number; rowIssues?: unknown[]; issues?: unknown[]; applied?: boolean; ok?: boolean };
  if (j.kind === 'render') return String((j.result as { title?: string }).title ?? '');
  if (j.kind === 'export') return `${String(r.elements)} elements, ${String(r.relationships)} relationships`;
  const issues = (r.rowIssues?.length ?? 0) + (r.issues?.length ?? 0);
  const el = (r.elements ?? {}) as Counts;
  const rel = (r.relationships ?? {}) as Counts;
  const counts = `${el.created ?? 0} new, ${el.updated ?? 0} changed elements; ${rel.created ?? 0} new relationships`;
  return r.applied ? `Imported: ${counts}` : r.ok ? `Ready: ${counts}` : `Not imported: ${issues} problem${issues === 1 ? '' : 's'} (run a check in Import to see them)`;
}

