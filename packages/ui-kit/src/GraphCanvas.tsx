import { useId, useMemo, type ReactNode } from 'react';
import { CanvasTree, canvasGeometry, LAYER_COLORS, labelSize, truncate, type CanvasLayout, type Route } from '@d4/render';
import { GraphCanvasTable } from './GraphCanvasTable';

/** A node as Graph Studio and Ingestion Studio pass it (CT-2). */
export interface GraphCanvasNode {
  id: string;
  name: string;
  type: string;
  layer: string;
  recordId?: string;
  state: 'in-graph' | 'planned';
}

/** A relationship; the arrow points from `from` to `to` (CT-2). */
export interface GraphCanvasEdge {
  id?: string;
  from: string;
  to: string;
  type: string;
  planned: boolean;
}

export interface GraphCanvasProps {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  /** The matching roots, visibly marked. */
  rootIds: string[];
  /** The host owns the selection (CT-5): set it from `onSelect`. */
  selectedId?: string | null;
  /** Graph or table; both show the same result and the same selection (GV-1). Default graph. */
  view?: GraphCanvasView;
  /** Open table rows as paths (r1/iv). Default: the roots, so the tree opens at level 1. */
  expandedIds?: string[];
  layout?: CanvasLayout;
  /** Metamodel layer order, for the By layer layout. */
  layers?: readonly string[];
  /** Fill the positioned box the host gives it. */
  fill?: boolean;
  loading?: boolean;
  /** Above this, the too-large state shows and nothing is drawn (GV-6). Default 1,000. */
  maxNodes?: number;
  onSelect?(id: string | null): void;
  /** Double-click on a node: drill down to it (GV-5a). */
  onDrill?(id: string): void;
  /** A chevron, Expand all or Collapse all was used: the full new list of open rows. */
  onExpandedChange?(paths: string[]): void;
  /** Shown instead of the result when there are no nodes (e.g. "Find a node to start"). */
  emptyMessage?: ReactNode;
  /** Hops loaded from each root (GC-2); the depth buttons show only with `onDepthChange`. */
  depth?: number;
  maxDepth?: number;
  /** Focus path: what the user searched for, then one step per drill (GC-3, DD-2). */
  crumbs?: { label: string }[];
  /** Small text at the top right. */
  caption?: ReactNode;
  onViewChange?(view: GraphCanvasView): void;
  onLayoutChange?(layout: CanvasLayout): void;
  onDepthChange?(depth: number): void;
  /** An earlier breadcrumb step was chosen, or Back (the step before the last). */
  onCrumb?(index: number): void;
}

export type GraphCanvasView = 'graph' | 'table';
export type { CanvasLayout };

const LAYOUTS: { id: CanvasLayout; label: string; icon: string }[] = [
  { id: 'hier', label: 'Hierarchical', icon: 'M8 2v4M8 6L3 10M8 6l5 4M1 10h4v4H1zM11 10h4v4h-4z' },
  { id: 'flow', label: 'Flow', icon: 'M1 6h4v4H1zM11 1h4v4h-4zM11 11h4v4h-4zM5 8h3M8 3v10M8 3h3M8 13h3' },
  { id: 'layers', label: 'By layer', icon: 'M1 2h14M1 8h14M1 14h14M3 1v2M9 1v2M6 7v2M12 7v2M4 13v2' },
  { id: 'radial', label: 'Radial', icon: 'M8 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 1v3M8 12v3M1 8h3M12 8h3' },
  { id: 'force', label: 'Force-directed', icon: 'M3 3l10 4M3 3l3 10M13 7l-7 6M3 3m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0' },
];

/**
 * Graph Studio's result (GC-1): a top bar (title and focus path), an option bar (the Graph and
 * Table tabs, then options for the chosen view), the result edge to edge, and a status bar (result
 * summary and, in the graph, the line legend). It fetches nothing and keeps no data of its own:
 * the host passes the result and every setting, and listens to the events.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  const {
    nodes,
    edges,
    rootIds,
    view = 'graph',
    layout = 'hier',
    depth,
    maxDepth = 6,
    crumbs = [],
    caption,
    fill = false,
    loading = false,
    onViewChange,
    onLayoutChange,
    onDepthChange,
    onCrumb,
    onExpandedChange,
  } = props;
  const tabsId = useId();
  const tree = useMemo(
    () => (view === 'table' ? new CanvasTree({ nodeIds: nodes.map((n) => n.id), edges, rootIds }) : null),
    [view, nodes, edges, rootIds],
  );
  const hasResult = !loading && nodes.length > 0;
  const planned = edges.filter((e) => e.planned).length;

  return (
    <section className={`graph-canvas${fill ? ' fill' : ''}`} aria-labelledby={`${tabsId}-title`}>
      <header className="graph-canvas-top">
        <h2 id={`${tabsId}-title`}>Result</h2>
        {crumbs.length > 1 && onCrumb && (
          <button type="button" className="button ghost small" onClick={() => onCrumb(crumbs.length - 2)}>
            <span aria-hidden="true">‹</span> Back
          </button>
        )}
        {crumbs.length > 0 && (
          <nav aria-label="Focus path" className="graph-canvas-crumbs">
            <ol>
              {crumbs.map((c, i) => (
                <li key={i}>
                  {i < crumbs.length - 1 ? (
                    <button type="button" className="link" onClick={() => onCrumb?.(i)}>
                      {c.label}
                    </button>
                  ) : (
                    <span aria-current="location">{c.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {caption && <span className="graph-canvas-caption">{caption}</span>}
      </header>

      <div className="graph-canvas-options">
        <div role="tablist" aria-label="Result view" className="graph-canvas-tabs">
          {(['graph', 'table'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => onViewChange?.(v)}>
              {v === 'graph' ? 'Graph' : 'Table'}
            </button>
          ))}
        </div>
        {onDepthChange && (
          <div className="graph-canvas-option" role="group" aria-label="Depth">
            <span className="graph-canvas-option-label" aria-hidden="true">
              Depth
            </span>
            {Array.from({ length: maxDepth }, (_, i) => i + 1).map((d) => (
              <button key={d} type="button" className="graph-canvas-seg" aria-pressed={d === depth} aria-label={`Depth ${d}`} onClick={() => onDepthChange(d)}>
                {d}
              </button>
            ))}
          </div>
        )}
        {view === 'graph' && onLayoutChange && (
          <div className="graph-canvas-option" role="group" aria-label="Layout">
            <span className="graph-canvas-option-label" aria-hidden="true">
              Layout
            </span>
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" className="graph-canvas-seg icon" aria-pressed={l.id === layout} aria-label={l.label} title={l.label} onClick={() => onLayoutChange(l.id)}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d={l.icon} />
                </svg>
              </button>
            ))}
          </div>
        )}
        {view === 'table' && tree && (
          <div className="graph-canvas-option end">
            <button type="button" className="button ghost small" disabled={!hasResult} onClick={() => onExpandedChange?.(tree.allExpandable())}>
              Expand all <span aria-hidden="true">+</span>
            </button>
            <button type="button" className="button ghost small" disabled={!hasResult} onClick={() => onExpandedChange?.([])}>
              Collapse all <span aria-hidden="true">−</span>
            </button>
          </div>
        )}
      </div>

      <CanvasBody {...props} />

      <footer className="graph-canvas-status">
        {hasResult && (
          <ul className="graph-canvas-summary" aria-label="Result summary">
            <li>
              {rootIds.length} {rootIds.length === 1 ? 'root' : 'roots'}
            </li>
            <li>
              {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
            </li>
            <li>{planned} planned {planned === 1 ? 'edge' : 'edges'}</li>
          </ul>
        )}
        {view === 'graph' && hasResult && (
          <ul className="graph-canvas-legend" aria-label="Legend">
            <li>
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" />
              </svg>
              current
            </li>
            <li>
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" className="planned" />
              </svg>
              planned
            </li>
          </ul>
        )}
      </footer>
    </section>
  );
}

/** The result itself, between the option bar and the status bar: graph or table, or a state. */
function CanvasBody({
  nodes,
  edges,
  rootIds,
  selectedId = null,
  view = 'graph',
  expandedIds,
  layout = 'hier',
  layers = [],
  loading = false,
  maxNodes = 1000,
  onSelect,
  onDrill,
  emptyMessage = 'Nothing to show.',
  onExpandedChange,
}: GraphCanvasProps) {
  const markerId = useId();
  const tooLarge = nodes.length > maxNodes;
  const graphShown = view === 'graph' && !loading && !tooLarge;
  const keyed = useMemo(() => edges.map((e, i) => ({ ...e, id: e.id ?? `${e.from}|${e.type}|${e.to}|${i}` })), [edges]);
  // Laid out only while the graph shows; switching views keeps everything else (Q-2).
  const geometry = useMemo(
    () =>
      !graphShown
        ? null
        : canvasGeometry(
            nodes.map((n) => ({ id: n.id, layer: n.layer })),
            keyed.map((e) => ({ id: e.id, from: e.from, to: e.to, label: edgeLabel(e.type) })),
            rootIds,
            layout,
            layers,
          ),
    [nodes, keyed, rootIds, layout, layers, graphShown],
  );

  const cls = 'graph-canvas-body';
  if (loading) {
    return (
      <div className={cls}>
        <p className="graph-canvas-state" role="status">
          Loading the result…
        </p>
      </div>
    );
  }
  if (tooLarge) {
    return (
      <div className={cls}>
        <p className="graph-canvas-state" role="alert">
          This result has {nodes.length.toLocaleString()} nodes, more than the {maxNodes.toLocaleString()} the canvas
          shows. Lower Depth or narrow the search.
        </p>
      </div>
    );
  }
  if (!nodes.length) {
    return (
      <div className={cls}>
        <div className="graph-canvas-state">{emptyMessage}</div>
      </div>
    );
  }
  if (view === 'table' || !geometry) {
    return (
      <div className={cls}>
        <GraphCanvasTable
          nodes={nodes}
          edges={edges}
          rootIds={rootIds}
          selectedId={selectedId}
          expandedIds={expandedIds ?? rootIds}
          onSelect={onSelect}
          onExpandedChange={onExpandedChange}
        />
      </div>
    );
  }

  const roots = new Set(rootIds);
  const byId = new Map(keyed.map((e) => [e.id, e]));
  return (
    <div className={cls}>
      <div className="graph-canvas-scroll">
        <svg
          className="graph-canvas-svg"
          width={geometry.width}
          height={geometry.height}
          role="group"
          aria-label={`Graph of ${nodes.length} nodes and ${keyed.length} relationships`}
          onClick={() => onSelect?.(null)}
        >
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="graph-canvas-arrow" />
            </marker>
          </defs>
          {geometry.routes.map((r) => (
            <Connector key={r.id} route={r} edge={byId.get(r.id)!} marker={markerId} />
          ))}
          {nodes.map((n) => {
            const b = geometry.boxes.get(n.id)!;
            const root = roots.has(n.id);
            const selected = n.id === selectedId;
            const state = [root && 'root', selected && 'selected', n.state === 'planned' && 'planned'].filter(Boolean).join(' ');
            return (
              <g
                key={n.id}
                className={`graph-canvas-node ${state}`}
                transform={`translate(${b.x},${b.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${n.name}, ${n.type}, ${n.layer}${root ? ', root' : ''}${n.state === 'planned' ? ', planned' : ''}`}
                data-node-id={n.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect?.(n.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onDrill?.(n.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(n.id);
                  }
                }}
              >
                <title>{n.name}</title>
                <rect className="graph-canvas-card" width={b.w} height={b.h} rx={6} />
                <rect className="graph-canvas-swatch" x={10} y={12} width={10} height={10} rx={2} style={{ fill: layerColor(n.layer) }} />
                <text className="graph-canvas-name" x={28} y={22}>
                  {truncate(n.name, 21)}
                </text>
                <text className="graph-canvas-meta" x={10} y={42}>
                  {truncate(`${n.type} · ${n.layer}`, root ? 18 : 28)}
                </text>
                {root && (
                  <text className="graph-canvas-root" x={b.w - 10} y={42} textAnchor="end">
                    Root
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Connector({ route, edge, marker }: { route: Route; edge: GraphCanvasEdge; marker: string }) {
  const text = edgeLabel(edge.type);
  const { w, h } = labelSize(text);
  const d = route.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  return (
    <g className={`graph-canvas-edge${edge.planned ? ' planned' : ''}`} data-edge-id={route.id}>
      <path d={d} markerEnd={`url(#${marker})`} />
      <rect className="graph-canvas-label-bg" x={route.label.x - w / 2} y={route.label.y - h / 2} width={w} height={h} rx={3} />
      <text className="graph-canvas-label" x={route.label.x} y={route.label.y + 4} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

/** ENABLED_BY → ENABLED BY (GV-3a). */
const edgeLabel = (type: string) => type.replace(/_/g, ' ');

/** The layer's theme token, with the fixed palette, then the System colour, as fallbacks (CT-5). */
const layerColor = (layer: string) =>
  `var(--layer-${layer.toLowerCase()}, ${LAYER_COLORS[layer] ?? 'var(--layer-system, #8d8d8d)'})`;
