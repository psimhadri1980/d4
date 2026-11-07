import { useId } from 'react';
import { ErrorBanner } from '@d4/ui-kit';
import type { exploreApi } from './api';

type StudioPaths = Awaited<ReturnType<typeof exploreApi.studioPaths>>;

/**
 * The Connection pattern's path list (D89): every shortest path between two nodes, shortest first,
 * as a line of names and links. Choosing one shows only it on the canvas; All paths shows them all.
 */
export function Connections({ paths, loading, error, chosen, onChoose, onClose }: { paths?: StudioPaths; loading: boolean; error: unknown; chosen: number | null; onChoose(i: number | null): void; onClose(): void }) {
  const id = useId();
  const names = new Map((paths?.elements ?? []).map((e) => [e.id, String(e.attrs['name'] ?? e.id)]));
  const rels = new Map((paths?.relationships ?? []).map((r) => [r.id, r]));
  const list = paths?.paths ?? [];
  return (
    <section className="graph-studio-impact" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>Connections</h3>
        <span className="graph-studio-impact-count" aria-live="polite">
          {loading ? 'Looking…' : list.length ? `${list.length}${paths?.truncated ? '+' : ''} shortest ${list.length === 1 ? 'path' : 'paths'}, ${list[0]!.length} ${list[0]!.length === 1 ? 'link' : 'links'}` : 'Not connected within six links'}
        </span>
        <button type="button" className="button ghost small" aria-pressed={chosen === null} disabled={!list.length} onClick={() => onChoose(null)}>
          All paths
        </button>
        <button type="button" className="button ghost small" onClick={onClose}>
          Close
        </button>
      </header>
      {error ? <ErrorBanner error={error} /> : null}
      <ol className="graph-studio-paths">
        {list.map((p, i) => (
          <li key={i}>
            <button type="button" className="graph-studio-path" aria-pressed={chosen === i} onClick={() => onChoose(chosen === i ? null : i)}>
              {p.nodeIds.map((n, j) => {
                const r = rels.get(p.relationshipIds[j] ?? '');
                const out = r?.fromId === n;
                return (
                  <span key={j}>
                    <strong>{names.get(n)}</strong>
                    {r && <span className="graph-studio-path-link">{` ${out ? '' : '←'}${r.type.replace(/_/g, ' ').toLowerCase()}${out ? '→' : ''} `}</span>}
                  </span>
                );
              })}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
