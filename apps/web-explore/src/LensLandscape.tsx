import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import type { LensStep } from '@d4/core';
import type { useRegistry, ViewParams } from '@d4/web-platform';
import { ErrorBanner } from '@d4/ui-kit';
import { exploreApi } from './api';

type StudioMatrix = Awaited<ReturnType<typeof exploreApi.studioMatrix>>;
type Node = StudioMatrix['rows'][number];
type MetamodelRegistry = NonNullable<ReturnType<typeof useRegistry>['data']>;

/** Theme colours for an attribute's values, in the order the metamodel lists them. */
const SWATCHES = ['business', 'application', 'data', 'technology', 'strategy', 'planning', 'governance', 'organisation', 'design', 'other'].map((l) => `var(--layer-${l})`);

/**
 * The Landscape pattern (D91): each root a box holding what its step reaches, as tiles coloured by
 * one enum attribute of theirs, with a legend. It reads the same rows and links as a matrix.
 */
export function LensLandscape({ ws, registry: reg, rootIds, step, view, selectedId, onSelect, onClose }: { ws: string; registry: MetamodelRegistry; rootIds: string[]; step: LensStep; view: ViewParams; selectedId: string | null; onSelect(id: string): void; onClose(): void }) {
  const id = useId();
  const colourId = useId();
  const read = useQuery({
    queryKey: ['studio-matrix', ws, rootIds, step, view],
    enabled: rootIds.length > 0,
    queryFn: () => exploreApi.studioMatrix(ws, { ids: rootIds, step }, view),
  });
  const m = read.data;
  // Enum attributes of the tiles' types, with their values in metamodel order.
  const attributes = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const t of new Set((m?.columns ?? []).map((c) => c.type)))
      for (const a of reg.attributesFor(t)) if (a.type === 'enum' && a.enum && !out.has(a.name)) out.set(a.name, reg.metamodel.enums[a.enum] ?? []);
    return out;
  }, [m, reg]);
  const [chosen, setChosen] = useState<string | null>(null);
  const colourBy = chosen !== null ? chosen : attributes.has('lifecycle') ? 'lifecycle' : ([...attributes.keys()][0] ?? '');
  const values = attributes.get(colourBy) ?? [];
  const colour = (n: Node) => {
    const i = values.indexOf(String(n.attrs[colourBy] ?? ''));
    return i < 0 ? undefined : SWATCHES[i % SWATCHES.length];
  };
  const byId = new Map((m?.columns ?? []).map((c) => [c.id, c]));
  const held = new Map<string, Node[]>();
  for (const c of m?.cells ?? []) held.set(c.row, [...(held.get(c.row) ?? []), byId.get(c.column)!]);
  const used = new Set((m?.columns ?? []).map((c) => String(c.attrs[colourBy] ?? '')));
  return (
    <section className="graph-studio-impact" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>Landscape</h3>
        <span className="graph-studio-impact-count" aria-live="polite">
          {read.isLoading ? 'Loading…' : m ? `${m.rows.length} ${m.rows.length === 1 ? 'box' : 'boxes'}, ${m.columns.length}${m.truncated ? '+' : ''} inside` : ''}
        </span>
        {attributes.size > 0 && (
          <span className="graph-studio-landscape-colour">
            <label htmlFor={colourId}>Colour by</label>
            <select id={colourId} value={colourBy} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Nothing</option>
              {[...attributes.keys()].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </span>
        )}
        <button type="button" className="button ghost small" onClick={onClose}>
          Close
        </button>
      </header>
      {read.error ? <ErrorBanner error={read.error} /> : null}
      {colourBy && values.length > 0 && (
        <ul className="graph-studio-landscape-legend" aria-label="Legend">
          {values
            .filter((v) => used.has(v))
            .map((v) => (
              <li key={v}>
                <span className="graph-studio-landscape-swatch" style={{ background: SWATCHES[values.indexOf(v) % SWATCHES.length] }} /> {v.replace(/_/g, ' ')}
              </li>
            ))}
        </ul>
      )}
      {m && (
        <div className="graph-studio-landscape">
          {m.rows.map((r) => {
            const inside = (held.get(r.id) ?? []).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
            return (
              <section key={r.id} className={`graph-studio-landscape-box${inside.length ? '' : ' empty'}`} aria-label={nameOf(r)}>
                <h4>
                  <button type="button" className="link" aria-pressed={selectedId === r.id} onClick={() => onSelect(r.id)}>
                    {nameOf(r)}
                  </button>
                  <span className="graph-studio-impact-count">{inside.length}</span>
                </h4>
                {inside.length ? (
                  <ul>
                    {inside.map((n) => {
                      const c = colour(n);
                      return (
                        <li key={n.id}>
                          <button
                            type="button"
                            className="graph-studio-landscape-tile"
                            aria-pressed={selectedId === n.id}
                            title={colourBy ? `${nameOf(n)} · ${colourBy}: ${String(n.attrs[colourBy] ?? 'none')}` : nameOf(n)}
                            style={c ? { borderLeftColor: c } : undefined}
                            onClick={() => onSelect(n.id)}
                          >
                            {nameOf(n)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted small">Nothing inside.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

const nameOf = (e: Node) => String(e.attrs['name'] ?? e.id);
