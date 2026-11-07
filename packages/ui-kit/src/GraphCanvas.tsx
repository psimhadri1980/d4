import { useId, useMemo, type ReactNode } from 'react';
import { applyCanvasFilter, CanvasTree, filterActive, kindCounts, NO_ADJUSTMENTS, NO_FILTER, type CanvasAdjustments, type CanvasFilter, type CanvasLayout } from '@d4/render';
import { GraphCanvasGraph, type CanvasViewport } from './GraphCanvasGraph';
import { GraphCanvasOverview } from './GraphCanvasOverview';
import { GraphCanvasFilterButton, GraphCanvasFilterChips } from './GraphCanvasFilter';
import { GraphCanvasTable } from './GraphCanvasTable';

/** A node as Graph Studio and Ingestion Studio pass it (CT-2). */
export interface GraphCanvasNode {
  id: string;
  name: string;
  type: string;
  layer: string;
  recordId?: string;
  state: 'in-graph' | 'planned';
  /** Shown at the Detail level (ZM-3). */
  owner?: string;
  changedAt?: string;
  /** A group of folded links (D85): how many nodes it holds. It opens on a click. */
  group?: number;
  /** Kept on the canvas by the user through drills and new searches. */
  pinned?: boolean;
  /** Its column in the Flow layout (a Flow lens's level, D88); hops from the roots when absent. */
  column?: number;
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
  /** Flow layout: a heading per node `column` (a viewpoint chain's stages, D88). */
  columns?: Readonly<Record<number, string>>;
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
  /** "Show only": ticked node and relationship types; empty lists show everything (FK-1). */
  filter?: CanvasFilter;
  /** The Filter button shows only with this. */
  onFilterChange?(filter: CanvasFilter): void;
  /** Nodes, connectors and labels the user moved, for the current layout (GV-5, GV-5b). */
  adjustments?: CanvasAdjustments;
  /** Dragging, arrow keys and Reset layout work only with this. */
  onAdjustmentsChange?(adjustments: CanvasAdjustments): void;
  /** Zoom and scroll of the graph view; absent, it fits the result to the pane (ZM-6). */
  viewport?: CanvasViewport | null;
  /** Where the view settled after a scroll, pan or zoom, so the host can keep it per step (DD-4). */
  onViewportChange?(viewport: CanvasViewport): void;
  /** Keep the selected node centred as the zoom changes (ZM-4). */
  followSelection?: boolean;
  onFollowSelectionChange?(follow: boolean): void;
}

/** Overview (OV-1), graph or table. */
export type GraphCanvasView = 'overview' | 'graph' | 'table';
export type { CanvasAdjustments, CanvasFilter, CanvasLayout, CanvasViewport };

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
    filter = NO_FILTER,
    onFilterChange,
    adjustments = NO_ADJUSTMENTS,
    onAdjustmentsChange,
  } = props;
  const adjusted = Object.keys(adjustments.nodes).length + Object.keys(adjustments.bends).length + Object.keys(adjustments.labels).length > 0;
  const tabsId = useId();
  const counts = useMemo(() => kindCounts(nodes, edges), [nodes, edges]);
  // Both views, and the summary, show the filtered result (FK-2).
  const shown = useMemo(() => applyCanvasFilter(nodes, edges, rootIds, filter), [nodes, edges, rootIds, filter]);
  const tree = useMemo(
    () => (view === 'table' ? new CanvasTree({ nodeIds: shown.nodes.map((n) => n.id), edges: shown.edges, rootIds }) : null),
    [view, shown, rootIds],
  );
  const hasResult = !loading && nodes.length > 0;
  const planned = shown.edges.filter((e) => e.planned).length;
  const filtered = filterActive(filter);

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
          {(['overview', 'graph', 'table'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => onViewChange?.(v)}>
              {{ overview: 'Overview', graph: 'Graph', table: 'Table' }[v]}
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
            {onAdjustmentsChange && (
              <button
                type="button"
                className="graph-canvas-seg icon reset"
                aria-label="Reset layout"
                title="Reset layout: put every node, connector and label back"
                disabled={!adjusted}
                onClick={() => onAdjustmentsChange(NO_ADJUSTMENTS)}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2v3h3" />
                </svg>
              </button>
            )}
          </div>
        )}
        {view === 'table' && tree && (
          <div className="graph-canvas-option">
            <button type="button" className="button ghost small" disabled={!hasResult} onClick={() => onExpandedChange?.(tree.allExpandable())}>
              Expand all <span aria-hidden="true">+</span>
            </button>
            <button type="button" className="button ghost small" disabled={!hasResult} onClick={() => onExpandedChange?.([])}>
              Collapse all <span aria-hidden="true">−</span>
            </button>
          </div>
        )}
        {onFilterChange && hasResult && (
          <div className="graph-canvas-option end">
            <GraphCanvasFilterButton filter={filter} counts={counts} onChange={onFilterChange} />
          </div>
        )}
      </div>
      {onFilterChange && <GraphCanvasFilterChips filter={filter} onChange={onFilterChange} />}

      {view === 'overview' && hasResult && nodes.length <= (props.maxNodes ?? 1000) ? (
        <div className="graph-canvas-body">
          {/* The whole result, so any type can be isolated; the filter only dims. */}
          <GraphCanvasOverview
            nodes={nodes}
            edges={edges}
            ticked={filter.nodeTypes}
            onIsolate={(type) => {
              // Isolate is ticking just that type (FK-2), in the graph (OV-2).
              onFilterChange?.({ nodeTypes: [type], relationshipTypes: [] });
              onViewChange?.('graph');
            }}
          />
        </div>
      ) : (
        <CanvasBody {...props} view={view === 'overview' ? 'graph' : view} nodes={shown.nodes} edges={shown.edges} />
      )}

      <footer className="graph-canvas-status">
        {hasResult && (
          <ul className="graph-canvas-summary" aria-label="Result summary">
            <li>
              {rootIds.length} {rootIds.length === 1 ? 'root' : 'roots'}
            </li>
            <li>
              {filtered ? `${shown.nodes.length} of ${nodes.length}` : nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
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
  columns,
  loading = false,
  maxNodes = 1000,
  onSelect,
  onDrill,
  emptyMessage = 'Nothing to show.',
  onExpandedChange,
  adjustments = NO_ADJUSTMENTS,
  onAdjustmentsChange,
  viewport,
  onViewportChange,
  followSelection,
  onFollowSelectionChange,
}: GraphCanvasProps) {
  const tooLarge = nodes.length > maxNodes;
  const keyed = useMemo(() => edges.map((e, i) => ({ ...e, id: e.id ?? `${e.from}|${e.type}|${e.to}|${i}` })), [edges]);

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
  if (view === 'table') {
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

  // Laid out only while the graph shows; switching views keeps everything else (Q-2).
  return (
    <div className={cls}>
      <GraphCanvasGraph
        nodes={nodes}
        edges={keyed}
        rootIds={rootIds}
        selectedId={selectedId}
        layout={layout}
        layers={layers}
        columns={layout === 'flow' ? columns : undefined}
        adjustments={adjustments}
        onAdjustmentsChange={onAdjustmentsChange}
        onSelect={onSelect}
        onDrill={onDrill}
        viewport={viewport}
        onViewportChange={onViewportChange}
        follow={followSelection}
        onFollowChange={onFollowSelectionChange}
      />
    </div>
  );
}
