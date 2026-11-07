import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import type { LensStep } from '@d4/core';
import type { ViewParams } from '@d4/web-platform';
import { download, ErrorBanner } from '@d4/ui-kit';
import { exploreApi } from './api';

type StudioMatrix = Awaited<ReturnType<typeof exploreApi.studioMatrix>>;

/**
 * The Matrix pattern (D90): which roots relate to which nodes of the step's types. A cell shows the
 * relationships linking its row and column; a row with no link at all is a gap, and can be shown alone.
 */
export function LensMatrix({ ws, rootIds, rowLabel, step, view, selectedId, onSelect, onClose }: { ws: string; rootIds: string[]; rowLabel: string; step: LensStep; view: ViewParams; selectedId: string | null; onSelect(id: string): void; onClose(): void }) {
  const id = useId();
  const [gapsOnly, setGapsOnly] = useState(false);
  const matrix = useQuery({
    queryKey: ['studio-matrix', ws, rootIds, step, view],
    enabled: rootIds.length > 0,
    queryFn: () => exploreApi.studioMatrix(ws, { ids: rootIds, step }, view),
  });
  const m = matrix.data;
  const cells = useMemo(() => new Map((m?.cells ?? []).map((c) => [`${c.row}\u0000${c.column}`, c.relationships])), [m]);
  const linked = useMemo(() => new Set((m?.cells ?? []).map((c) => c.row)), [m]);
  const gaps = (m?.rows ?? []).filter((r) => !linked.has(r.id)).length;
  const rows = (m?.rows ?? []).filter((r) => !gapsOnly || !linked.has(r.id));
  const columns = m?.columns ?? [];
  const to = step.stage ?? step.types?.join(', ') ?? 'Linked';
  return (
    <section className="graph-studio-impact" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>Matrix</h3>
        <span className="graph-studio-impact-count" aria-live="polite">
          {matrix.isLoading ? 'Loading…' : m ? `${m.rows.length} × ${columns.length}${m.truncated ? '+' : ''} ${to}, ${gaps} without a link` : ''}
        </span>
        <label className="graph-studio-matrix-gaps">
          <input type="checkbox" checked={gapsOnly} disabled={!gaps} onChange={(e) => setGapsOnly(e.target.checked)} /> Only rows without a link
        </label>
        <button type="button" className="button small" disabled={!m?.rows.length} onClick={() => m && download('matrix.csv', matrixCsv(m, rowLabel), 'text/csv')}>
          Export CSV
        </button>
        <button type="button" className="button ghost small" onClick={onClose}>
          Close
        </button>
      </header>
      {matrix.error ? <ErrorBanner error={matrix.error} /> : null}
      {m && (
        <div className="matrix-scroll">
          <table className="matrix" aria-labelledby={`${id}-title`}>
            <thead>
              <tr>
                <th scope="col" className="corner">
                  {rowLabel} ↓ · {to} →
                </th>
                {columns.map((c) => (
                  <th key={c.id} scope="col" className="col-head">
                    <span>
                      <button type="button" className="link" aria-pressed={selectedId === c.id} onClick={() => onSelect(c.id)}>
                        {nameOf(c)}
                      </button>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={linked.has(r.id) ? undefined : 'graph-studio-matrix-gap'}>
                  <th scope="row" className="row-head">
                    <button type="button" className="link" aria-pressed={selectedId === r.id} onClick={() => onSelect(r.id)}>
                      {nameOf(r)}
                    </button>
                  </th>
                  {columns.map((c) => {
                    const v = cells.get(`${r.id}\u0000${c.id}`);
                    return (
                      <td key={c.id} title={v ? `${nameOf(r)} · ${nameOf(c)}: ${v.map(words).join(', ')}` : undefined}>
                        {v && <span className="mcell v-realizes">✓</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const nameOf = (e: StudioMatrix['rows'][number]) => String(e.attrs['name'] ?? e.id);
const words = (t: string) => t.replace(/_/g, ' ').toLowerCase();

function matrixCsv(m: StudioMatrix, rowLabel: string): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cells = new Map(m.cells.map((c) => [`${c.row}\u0000${c.column}`, c.relationships]));
  const header = [rowLabel, ...m.columns.map(nameOf)];
  const lines = m.rows.map((r) => [nameOf(r), ...m.columns.map((c) => (cells.get(`${r.id}\u0000${c.id}`) ?? []).join(' '))].map(esc).join(','));
  return [header.map(esc).join(','), ...lines].join('\n');
}
