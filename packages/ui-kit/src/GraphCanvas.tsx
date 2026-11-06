import { useId, useMemo } from 'react';
import { canvasGeometry, LAYER_COLORS, labelSize, truncate, type CanvasLayout, type Route } from '@d4/render';
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
}

export type GraphCanvasView = 'graph' | 'table';

/**
 * Graph Studio's result canvas (graph view): node cards, labelled directed connectors, solid for
 * current and dashed for planned relationships. It fetches nothing and keeps no data of its own;
 * the host passes the result and listens to the events.
 */
export function GraphCanvas({
  nodes,
  edges,
  rootIds,
  selectedId = null,
  view = 'graph',
  expandedIds,
  layout = 'hier',
  layers = [],
  fill = false,
  loading = false,
  maxNodes = 1000,
  onSelect,
  onDrill,
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

  const cls = `graph-canvas${fill ? ' fill' : ''}`;
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
        <p className="graph-canvas-state">Nothing to show.</p>
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
