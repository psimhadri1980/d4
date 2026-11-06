import { useEffect, useId, useRef, useState } from 'react';
import { filterActive, type CanvasFilter } from '@d4/render';

type Counts = { type: string; count: number }[];

interface ButtonProps {
  filter: CanvasFilter;
  counts: { nodeTypes: Counts; relationshipTypes: Counts };
  onChange(f: CanvasFilter): void;
}

/**
 * The icon-only Filter button at the end of the option bar and its "Show only" panel (FK-1): every
 * node type and relationship type in the result with its count. Inclusion: All is ticked by
 * default; ticking a type shows only it, each further tick widens the view, All goes back.
 */
export function GraphCanvasFilterButton({ filter, counts, onChange }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const box = useRef<HTMLDivElement>(null);
  const ticked = filter.nodeTypes.length + filter.relationshipTypes.length;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  return (
    <div className="graph-canvas-filter" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="graph-canvas-seg icon"
        aria-label={ticked ? `Filter, ${ticked} ticked` : 'Filter'}
        title="Filter"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" />
        </svg>
        {ticked > 0 && (
          <span className="graph-canvas-badge" aria-hidden="true">
            {ticked}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="graph-canvas-filter-panel" role="dialog" aria-label="Show only">
          <KindList legend="Node types" all="All node types" counts={counts.nodeTypes} ticked={filter.nodeTypes} onChange={(nodeTypes) => onChange({ ...filter, nodeTypes })} />
          <KindList
            legend="Relationships"
            all="All relationships"
            counts={counts.relationshipTypes}
            ticked={filter.relationshipTypes}
            label={(t) => t.replace(/_/g, ' ')}
            onChange={(relationshipTypes) => onChange({ ...filter, relationshipTypes })}
          />
          <div className="graph-canvas-filter-actions">
            <button type="button" className="button ghost small" disabled={!filterActive(filter)} onClick={() => onChange({ nodeTypes: [], relationshipTypes: [] })}>
              Clear
            </button>
            <button type="button" className="button small" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function KindList({
  legend,
  all,
  counts,
  ticked,
  label = (t) => t,
  onChange,
}: {
  legend: string;
  all: string;
  counts: Counts;
  ticked: readonly string[];
  label?: (t: string) => string;
  onChange(ticked: string[]): void;
}) {
  const id = useId();
  return (
    <fieldset className="graph-canvas-kinds">
      <legend>{legend}</legend>
      <label htmlFor={`${id}-all`}>
        <input id={`${id}-all`} type="checkbox" checked={!ticked.length} onChange={() => onChange([])} />
        {all}
      </label>
      {counts.map(({ type, count }, i) => (
        <label key={type} htmlFor={`${id}-${i}`}>
          <input
            id={`${id}-${i}`}
            type="checkbox"
            checked={ticked.includes(type)}
            onChange={(e) => onChange(e.target.checked ? [...ticked, type] : ticked.filter((t) => t !== type))}
          />
          {label(type)}
          <span className="graph-canvas-kind-count">{count}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** The ticked kinds as removable chips under the option bar, so the filter shows when the panel is closed (FK-2). */
export function GraphCanvasFilterChips({ filter, onChange }: { filter: CanvasFilter; onChange(f: CanvasFilter): void }) {
  if (!filterActive(filter)) return null;
  const chip = (text: string, drop: () => void) => (
    <li key={text}>
      {text}
      <button type="button" aria-label={`Remove ${text}`} onClick={drop}>
        ×
      </button>
    </li>
  );
  return (
    <div className="graph-canvas-chips">
      <span>Showing only:</span>
      <ul>
        {filter.nodeTypes.map((t) => chip(t, () => onChange({ ...filter, nodeTypes: filter.nodeTypes.filter((x) => x !== t) })))}
        {filter.relationshipTypes.map((t) =>
          chip(t.replace(/_/g, ' '), () => onChange({ ...filter, relationshipTypes: filter.relationshipTypes.filter((x) => x !== t) })),
        )}
      </ul>
      <button type="button" className="link" onClick={() => onChange({ nodeTypes: [], relationshipTypes: [] })}>
        Clear
      </button>
    </div>
  );
}
