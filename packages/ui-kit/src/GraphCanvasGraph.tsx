import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  canvasGeometry,
  canvasPlacement,
  LAYER_COLORS,
  labelSize,
  truncate,
  type CanvasAdjustments,
  type CanvasLayout,
  type Point,
  type Route,
} from '@d4/render';
import type { GraphCanvasEdge, GraphCanvasNode } from './GraphCanvas';

type Keyed = GraphCanvasEdge & { id: string };

interface Props {
  nodes: GraphCanvasNode[];
  edges: Keyed[];
  rootIds: string[];
  selectedId: string | null;
  layout: CanvasLayout;
  layers: readonly string[];
  adjustments: CanvasAdjustments;
  onAdjustmentsChange?(a: CanvasAdjustments): void;
  onSelect?(id: string | null): void;
  onDrill?(id: string): void;
}

/** What is being dragged, and where it started (client px and the value it moves). */
type Drag =
  | { kind: 'node'; id: string; from: Point; origin: Point; moved: boolean }
  | { kind: 'bend'; id: string; from: Point; origin: number; along: Point | null; moved: boolean }
  | { kind: 'label'; id: string; from: Point; origin: Point; moved: boolean };

/** Arrow keys move a selected node this far (GV-5). */
const STEP = 10;
/** Pointer travel before a press counts as a drag rather than a click. */
const SLOP = 3;

/**
 * The graph view of GraphCanvas, as SVG: node cards and labelled, directed connectors. Nodes,
 * connectors and labels can be dragged (GV-5, GV-5b); what the user moved is reported once, on
 * release, as the full set of adjustments, and the host keeps it per layout and focus step.
 */
export function GraphCanvasGraph({ nodes, edges, rootIds, selectedId, layout, layers, adjustments, onAdjustmentsChange, onSelect, onDrill }: Props) {
  const markerId = useId();
  const [live, setLive] = useState<CanvasAdjustments | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [labelId, setLabelId] = useState<string | null>(null);
  // A drag ends in a click on the same element; that click must not select.
  const swallowClick = useRef(false);
  const movable = !!onAdjustmentsChange;

  const layoutNodes = useMemo(() => nodes.map((n) => ({ id: n.id, layer: n.layer })), [nodes]);
  const layoutEdges = useMemo(() => edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: edgeLabel(e.type) })), [edges]);
  const placement = useMemo(() => canvasPlacement(layoutNodes, layoutEdges, rootIds, layout, layers), [layoutNodes, layoutEdges, rootIds, layout, layers]);
  const adjust = live ?? adjustments;
  const geometry = useMemo(
    () => canvasGeometry(layoutNodes, layoutEdges, rootIds, layout, layers, { placement, adjust }),
    [layoutNodes, layoutEdges, rootIds, layout, layers, placement, adjust],
  );

  const roots = new Set(rootIds);
  const byId = new Map(edges.map((e) => [e.id, e]));
  const routeOf = new Map(geometry.routes.map((r) => [r.id, r]));
  const centreOf = (id: string): Point => {
    const b = geometry.boxes.get(id)!;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };
  const commit = (next: CanvasAdjustments) => onAdjustmentsChange?.(next);

  const start = (e: ReactPointerEvent<SVGElement>, d: Drag) => {
    if (!movable || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(d);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.from.x;
    const dy = e.clientY - drag.from.y;
    if (!drag.moved && Math.hypot(dx, dy) < SLOP) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    const base = live ?? adjustments;
    if (drag.kind === 'node') setLive({ ...base, nodes: { ...base.nodes, [drag.id]: { x: drag.origin.x + dx, y: drag.origin.y + dy } } });
    if (drag.kind === 'label') setLive({ ...base, labels: { ...base.labels, [drag.id]: { x: drag.origin.x + dx, y: drag.origin.y + dy } } });
    if (drag.kind === 'bend') {
      const route = routeOf.get(drag.id)!;
      // Elbow: the bend line slides along its axis. Straight: the curve follows the pointer sideways.
      const delta = route.bend ? (route.bend.axis === 'y' ? dy : dx) : drag.along ? dx * drag.along.x + dy * drag.along.y : 0;
      setLive({ ...base, bends: { ...base.bends, [drag.id]: drag.origin + delta } });
    }
  };
  const end = () => {
    if (!drag) return;
    if (drag.moved && live) {
      swallowClick.current = true;
      commit(live);
    }
    setDrag(null);
    setLive(null);
  };
  const clicked = () => {
    if (!swallowClick.current) return false;
    swallowClick.current = false;
    return true;
  };

  const tie = labelId ? routeOf.get(labelId) : undefined;
  return (
    <div className="graph-canvas-scroll">
      <svg
        className={`graph-canvas-svg${drag?.moved ? ' dragging' : ''}`}
        width={geometry.width}
        height={geometry.height}
        viewBox={`${geometry.minX} ${geometry.minY} ${geometry.width} ${geometry.height}`}
        role="group"
        aria-label={`Graph of ${nodes.length} nodes and ${edges.length} relationships`}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onClick={() => {
          if (clicked()) return;
          setLabelId(null);
          onSelect?.(null);
        }}
      >
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="graph-canvas-arrow" />
          </marker>
        </defs>
        {geometry.routes.map((r) => (
          <Connector
            key={r.id}
            route={r}
            edge={byId.get(r.id)!}
            marker={markerId}
            lit={r.id === labelId}
            onLinePointerDown={(e) => {
              const [p, q] = [r.points[0]!, r.points.at(-1)!];
              const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
              start(e, { kind: 'bend', id: r.id, from: { x: e.clientX, y: e.clientY }, origin: r.bend?.at ?? r.curve ?? 0, along: r.bend ? null : { x: -(q.y - p.y) / len, y: (q.x - p.x) / len }, moved: false });
            }}
            onLabelPointerDown={(e) => start(e, { kind: 'label', id: r.id, from: { x: e.clientX, y: e.clientY }, origin: r.label, moved: false })}
            onLabelClick={() => {
              if (clicked()) return;
              setLabelId(r.id === labelId ? null : r.id);
            }}
            onLabelReset={() => {
              commit({ ...adjust, labels: without(adjust.labels, r.id), bends: without(adjust.bends, r.id) });
            }}
          />
        ))}
        {tie && <path className="graph-canvas-tie" d={`M${tie.label.x},${tie.label.y} L${tie.anchor.x},${tie.anchor.y}`} />}
        {nodes.map((n) => {
          const b = geometry.boxes.get(n.id)!;
          const root = roots.has(n.id);
          const selected = n.id === selectedId;
          const state = [root && 'root', selected && 'selected', n.state === 'planned' && 'planned', movable && 'movable'].filter(Boolean).join(' ');
          return (
            <g
              key={n.id}
              className={`graph-canvas-node ${state}`}
              transform={`translate(${b.x},${b.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${n.name}, ${n.type}, ${n.layer}${root ? ', root' : ''}${n.state === 'planned' ? ', planned' : ''}`}
              aria-keyshortcuts={movable ? 'ArrowUp ArrowDown ArrowLeft ArrowRight' : undefined}
              data-node-id={n.id}
              onPointerDown={(e) => start(e, { kind: 'node', id: n.id, from: { x: e.clientX, y: e.clientY }, origin: centreOf(n.id), moved: false })}
              onClick={(e) => {
                e.stopPropagation();
                if (clicked()) return;
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
                  return;
                }
                const step = { ArrowUp: [0, -STEP], ArrowDown: [0, STEP], ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0] }[e.key];
                if (!step || !movable) return;
                e.preventDefault();
                const c = centreOf(n.id);
                commit({ ...adjust, nodes: { ...adjust.nodes, [n.id]: { x: c.x + step[0]!, y: c.y + step[1]! } } });
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
  );
}

interface ConnectorProps {
  route: Route;
  edge: GraphCanvasEdge;
  marker: string;
  /** Its label is selected: the connector is highlighted and tied to the label. */
  lit: boolean;
  onLinePointerDown(e: ReactPointerEvent<SVGElement>): void;
  onLabelPointerDown(e: ReactPointerEvent<SVGElement>): void;
  onLabelClick(): void;
  onLabelReset(): void;
}

function Connector({ route, edge, marker, lit, onLinePointerDown, onLabelPointerDown, onLabelClick, onLabelReset }: ConnectorProps) {
  const text = edgeLabel(edge.type);
  const { w, h } = labelSize(text);
  const [p, q] = [route.points[0]!, route.points.at(-1)!];
  const d = route.control ? `M${p.x},${p.y} Q${route.control.x},${route.control.y} ${q.x},${q.y}` : route.points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x},${pt.y}`).join(' ');
  const cursor = route.bend ? (route.bend.axis === 'y' ? 'ns' : 'ew') : 'move';
  return (
    <g className={`graph-canvas-edge${edge.planned ? ' planned' : ''}${lit ? ' lit' : ''}`} data-edge-id={route.id}>
      <path d={d} markerEnd={`url(#${marker})`} />
      <path className={`graph-canvas-hit ${cursor}`} d={d} onPointerDown={onLinePointerDown} onClick={(e) => e.stopPropagation()}>
        <title>Drag to move this connector</title>
      </path>
      <g
        className="graph-canvas-label-box"
        onPointerDown={onLabelPointerDown}
        onClick={(e) => {
          e.stopPropagation();
          onLabelClick();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onLabelReset();
        }}
      >
        <title>Drag to place this label; double-click to reset it and its connector</title>
        <rect className="graph-canvas-label-bg" x={route.label.x - w / 2} y={route.label.y - h / 2} width={w} height={h} rx={3} />
        <text className="graph-canvas-label" x={route.label.x} y={route.label.y + 4} textAnchor="middle">
          {text}
        </text>
      </g>
    </g>
  );
}

const without = <T,>(rec: Readonly<Record<string, T>>, key: string) => Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));

/** ENABLED_BY → ENABLED BY (GV-3a). */
const edgeLabel = (type: string) => type.replace(/_/g, ' ');

/** The layer's theme token, with the fixed palette, then the System colour, as fallbacks (CT-5). */
const layerColor = (layer: string) => `var(--layer-${layer.toLowerCase()}, ${LAYER_COLORS[layer] ?? 'var(--layer-system, #8d8d8d)'})`;

