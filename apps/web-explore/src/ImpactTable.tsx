import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import type { LensStep } from '@d4/core';
import type { ViewParams } from '@d4/web-platform';
import { download, ErrorBanner } from '@d4/ui-kit';
import { exploreApi } from './api';

type Impact = Awaited<ReturnType<typeof exploreApi.studioImpact>>;

/** Attributes the table shows when the nodes have them. */
const EXTRA = ['lifecycle', 'owner', 'criticality'] as const;

/**
 * The impact table of a Flow lens (D88): everything the lens reaches from its roots, not only what
 * fits on the canvas, one row per node with its level and the link that first reached it.
 */
export function ImpactTable({ ws, rootIds, steps, view, onSelect, onClose }: { ws: string; rootIds: string[]; steps: LensStep[]; view: ViewParams; onSelect(id: string): void; onClose(): void }) {
  const id = useId();
  const impact = useQuery({
    queryKey: ['studio-impact', ws, rootIds, steps, view],
    enabled: rootIds.length > 0,
    queryFn: () => exploreApi.studioImpact(ws, { ids: rootIds, steps }, view),
  });
  const rows = impact.data?.rows ?? [];
  const extra = EXTRA.filter((a) => rows.some((r) => r.element.attrs[a] !== undefined));
  return (
    <section className="graph-studio-impact" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>Impact table</h3>
        <span className="graph-studio-impact-count" aria-live="polite">
          {impact.isLoading ? 'Loading…' : `${rows.length.toLocaleString()} ${rows.length === 1 ? 'node' : 'nodes'}${impact.data?.truncated ? ' (stopped at the limit)' : ''}`}
        </span>
        <button type="button" className="button small" disabled={!rows.length} onClick={() => download('impact.csv', impactCsv(rows, extra), 'text/csv')}>
          Export CSV
        </button>
        <button type="button" className="button ghost small" onClick={onClose}>
          Close
        </button>
      </header>
      {impact.error ? <ErrorBanner error={impact.error} /> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              {extra.map((a) => (
                <th key={a} scope="col">
                  {a.charAt(0).toUpperCase() + a.slice(1)}
                </th>
              ))}
              <th scope="col">Reached by</th>
              <th scope="col">From</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.element.id}>
                <td>{r.level}</td>
                <td>
                  <button type="button" className="link" onClick={() => onSelect(r.element.id)}>
                    {nameOf(r)}
                  </button>
                </td>
                <td>{r.element.type}</td>
                {extra.map((a) => (
                  <td key={a}>{String(r.element.attrs[a] ?? '')}</td>
                ))}
                <td>{r.relationship.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{r.fromName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const nameOf = (r: Impact['rows'][number]) => String(r.element.attrs['name'] ?? r.element.id);

function impactCsv(rows: Impact['rows'], extra: readonly string[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = ['level', 'id', 'name', 'type', ...extra, 'relationship', 'direction', 'fromId', 'fromName'];
  const lines = rows.map((r) => [String(r.level), r.element.id, nameOf(r), r.element.type, ...extra.map((a) => String(r.element.attrs[a] ?? '')), r.relationship, r.direction, r.from, r.fromName].map(esc).join(','));
  return [header.join(','), ...lines].join('\n');
}
