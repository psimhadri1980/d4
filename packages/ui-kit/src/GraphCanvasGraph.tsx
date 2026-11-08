import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  canvasGeometry,
  canvasPlacement,
  CARD,
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

/** Where the graph view is looking: zoom and scroll position, kept per focus step by the host (DD-4). */
export interface CanvasViewport {
  zoom: number;
  left: number;
  top: number;
}

/** Semantic zoom (ZM-3): how much each node shows. */
type CanvasLevel = 'dot' | 'label' | 'card' | 'detail';
const LEVELS: { id: CanvasLevel; label: string; zoom: number }[] = [
  { id: 'dot', label: 'Dot', zoom: 0.35 },
  { id: 'label', label: 'Label', zoom: 0.65 },
  { id: 'card', label: 'Card', zoom: 1 },
  { id: 'detail', label: 'Detail', zoom: 1.5 },
];
/** The level follows zoom: below 50 % dots, below 80 % labels, below 130 % cards, then details. */
const levelAt = (zoom: number): CanvasLevel => (zoom < 0.5 ? 'dot' : zoom < 0.8 ? 'label' : zoom < 1.3 ? 'card' : 'detail');
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
/** Fit never goes below the Dot level's zoom: smaller than that, nothing can be told apart. */
const FIT_FLOOR = 0.35;

/** Box size per level, in canvas units; connectors end on these boxes at every level (ZM-5). */
const sizeAt = (level: CanvasLevel, name: string) =>
  level === 'dot' ? { w: 28, h: 28 } : level === 'label' ? { w: Math.min(CARD.w, 24 + name.length * 7.5), h: 30 } : level === 'detail' ? { w: CARD.w, h: 92 } : CARD;

interface Props {
  nodes: GraphCanvasNode[];
  edges: Keyed[];
  rootIds: string[];
  selectedId: string | null;
  layout: CanvasLayout;
  layers: readonly string[];
  columns?: Readonly<Record<number, string>>;
  adjustments: CanvasAdjustments;
  onAdjustmentsChange?(a: CanvasAdjustments): void;
  onSelect?(id: string | null): void;
  onDrill?(id: string): void;
  /** Absent: the view fits the result to the pane, and refits when the pane is resized. */
  viewport?: CanvasViewport | null;
  onViewportChange?(v: CanvasViewport): void;
  follow?: boolean;
  onFollowChange?(follow: boolean): void;
}

/** What is being dragged, and where it started (client px and the value it moves). */
type Drag =
  | { kind: 'node'; id: string; from: Point; origin: Point; moved: boolean }
  | { kind: 'bend'; id: string; from: Point; origin: number; along: Point | null; moved: boolean }
  | { kind: 'label'; id: string; from: Point; origin: Point; moved: boolean }
  | { kind: 'pan'; from: Point; origin: Point; moved: boolean };

/** Arrow keys move a selected node this far (GV-5). */
const STEP = 10;
/** Pointer travel before a press counts as a drag rather than a click. */
const SLOP = 3;

/**
 * The graph view of GraphCanvas, as SVG: node cards and labelled, directed connectors. Nodes,
 * connectors and labels can be dragged (GV-5, GV-5b); what the user moved is reported once, on
 * release, and the host keeps it per layout and focus step. The wheel zooms at the pointer and
 * dragging empty canvas pans (ZM-1); the zoom box jumps between levels of detail, follows the
 * selection and fits the result (ZM-2…ZM-4).
 */
export function GraphCanvasGraph(props: Props) {
  const { nodes, edges, rootIds, selectedId, layout, layers, columns, adjustments, onAdjustmentsChange, onSelect, onDrill, viewport, onViewportChange, follow = false, onFollowChange } = props;
  const markerId = useId();
  const [live, setLive] = useState<CanvasAdjustments | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [labelId, setLabelId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(viewport?.zoom ?? 1);
  // A drag ends in a click on the same element; that click must not select.
  const swallowClick = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  // Scroll to apply once the next render has resized the drawing.
  const pendingScroll = useRef<Point | null>(null);
  // Fitted views refit when the pane changes size; zooming by hand ends that.
  const fitted = useRef(!viewport);
  const movable = !!onAdjustmentsChange;
  const level = levelAt(zoom);

  const layoutNodes = useMemo(() => nodes.map((n) => ({ id: n.id, layer: n.layer, ...(n.column !== undefined && { rank: n.column }) })), [nodes]);
  const layoutEdges = useMemo(() => edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: edgeLabel(e.type) })), [edges]);
  const placement = useMemo(() => canvasPlacement(layoutNodes, layoutEdges, rootIds, layout, layers), [layoutNodes, layoutEdges, rootIds, layout, layers]);
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const adjust = live ?? adjustments;
  const geometry = useMemo(
    () => canvasGeometry(layoutNodes, layoutEdges, rootIds, layout, layers, { placement, adjust, size: (id) => sizeAt(level, names.get(id) ?? '') }),
    [layoutNodes, layoutEdges, rootIds, layout, layers, placement, adjust, level, names],
  );
  // Flow column headings (D88): over each column's nodes, above the topmost card.
  const headings = useMemo(() => {
    if (!columns) return [];
    const xs = new Map<number, number[]>();
    let top = Infinity;
    for (const n of nodes) {
      const b = geometry.boxes.get(n.id);
      if (!b || n.column === undefined || columns[n.column] === undefined) continue;
      xs.set(n.column, [...(xs.get(n.column) ?? []), b.x + b.w / 2]);
      top = Math.min(top, b.y);
    }
    return [...xs].sort(([a], [b]) => a - b).map(([c, x]) => ({ column: c, label: columns[c]!, x: x.reduce((s, v) => s + v, 0) / x.length, y: top - 14 }));
  }, [columns, nodes, geometry]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) for (const id of [e.from, e.to]) d.set(id, (d.get(id) ?? 0) + 1);
    return d;
  }, [edges]);

  // ── Viewport ──────────────────────────────────────────────────────────
  const geo = useRef(geometry);
  geo.current = geometry;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rootsRef = useRef(rootIds);
  rootsRef.current = rootIds;

  /** Zooms to `z`, keeping the canvas point under (px, py) of the pane where it is. */
  const zoomTo = (z: number, px?: number, py?: number) => {
    const el = scroller.current;
    const next = clampZoom(z);
    if (!el) return setZoom(next);
    const x = px ?? el.clientWidth / 2;
    const y = py ?? el.clientHeight / 2;
    const g = geo.current;
    const cx = (el.scrollLeft + x) / zoomRef.current + g.minX;
    const cy = (el.scrollTop + y) / zoomRef.current + g.minY;
    pendingScroll.current = { x: (cx - g.minX) * next - x, y: (cy - g.minY) * next - y };
    setZoom(next);
  };
  /**
   * Fit: the whole result in the pane, no larger than 100 % and no smaller than the Dot level.
   * A result too wide even for that is centred on its first root; scroll or pan for the rest.
   */
  const fit = () => {
    const el = scroller.current;
    const g = geo.current;
    if (!el || !el.clientWidth) return;
    fitted.current = true;
    const whole = Math.min(el.clientWidth / g.width, el.clientHeight / g.height, 1);
    const z = clampZoom(Math.max(whole, FIT_FLOOR));
    pendingScroll.current = { x: (g.width * z - el.clientWidth) / 2, y: (g.height * z - el.clientHeight) / 2 };
    if (whole < FIT_FLOOR && rootsRef.current[0]) centreOn(rootsRef.current[0], z);
    setZoom(z);
  };
  const centreOn = (id: string, z = zoomRef.current) => {
    const el = scroller.current;
    const b = geo.current.boxes.get(id);
    if (!el || !b) return;
    pendingScroll.current = { x: (b.x + b.w / 2 - geo.current.minX) * z - el.clientWidth / 2, y: (b.y + b.h / 2 - geo.current.minY) * z - el.clientHeight / 2 };
  };

  // A new result, or a viewport the host restores: fit, or go where the host says. A report still
  // pending belongs to what was shown before, so it goes out first.
  useLayoutEffect(() => {
    flushReport();
    if (viewport) {
      fitted.current = false;
      pendingScroll.current = { x: viewport.left, y: viewport.top };
      setZoom(clampZoom(viewport.zoom));
    } else fit();
  }, [viewport, nodes, edges, layout]);

  // Follow selection keeps the selected node centred as zoom or level change (ZM-4).
  useLayoutEffect(() => {
    if (follow && selectedId) centreOn(selectedId, zoom);
  }, [follow, selectedId, zoom]);

  // After the drawing has its new size, scroll to where it should be.
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pendingScroll.current;
    if (!el || !p) return;
    pendingScroll.current = null;
    el.scrollLeft = Math.max(0, p.x);
    el.scrollTop = Math.max(0, p.y);
  });

  // The wheel zooms at the pointer (ZM-1); a native listener, since React's is passive.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      fitted.current = false;
      const r = el.getBoundingClientRect();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  // The canvas is never cut off: a fitted view refits when the pane is resized (ZM-6).
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fitted.current && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Report where the view is once scrolling or zooming settles: the values of now, sent a little
  // later, so a report never carries the next result's view.
  const report = useRef<{ timer: ReturnType<typeof setTimeout>; send: () => void } | null>(null);
  const flushReport = () => {
    const r = report.current;
    if (!r) return;
    report.current = null;
    clearTimeout(r.timer);
    r.send();
  };
  const reportViewport = () => {
    const el = scroller.current;
    if (!onViewportChange || !el) return;
    const v = { zoom: zoomRef.current, left: el.scrollLeft, top: el.scrollTop };
    if (report.current) clearTimeout(report.current.timer);
    const send = () => onViewportChange(v);
    report.current = { timer: setTimeout(() => ((report.current = null), send()), 250), send };
  };
  useEffect(() => () => flushReport(), []);
  // Not the zoom it mounts with: that is no view anyone settled on, and reported, the host would
  // restore it over the fit that follows, which reports again, and so on.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) reportViewport();
    mounted.current = true;
  }, [zoom]);

  // ── Dragging ──────────────────────────────────────────────────────────
  const roots = new Set(rootIds);
  const byId = new Map(edges.map((e) => [e.id, e]));
  const routeOf = new Map(geometry.routes.map((r) => [r.id, r]));
  const centreOf = (id: string): Point => {
    const b = geometry.boxes.get(id)!;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };
  const commit = (next: CanvasAdjustments) => onAdjustmentsChange?.(next);

  const start = (e: ReactPointerEvent<SVGElement>, d: Drag) => {
    if ((d.kind !== 'pan' && !movable) || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(d);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const sx = e.clientX - drag.from.x;
    const sy = e.clientY - drag.from.y;
    if (!drag.moved && Math.hypot(sx, sy) < SLOP) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    if (drag.kind === 'pan') {
      const el = scroller.current;
      if (el) {
        fitted.current = false;
        el.scrollLeft = drag.origin.x - sx;
        el.scrollTop = drag.origin.y - sy;
      }
      return;
    }
    // Screen pixels to canvas units.
    const dx = sx / zoom;
    const dy = sy / zoom;
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
    if (drag.moved) swallowClick.current = true;
    if (drag.moved && live) commit(live);
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
    <div className="graph-canvas-graph">
      <div className="graph-canvas-scroll" ref={scroller} onScroll={reportViewport}>
        <svg
          className={`graph-canvas-svg level-${level}${drag?.moved ? ' dragging' : ''}`}
          width={geometry.width * zoom}
          height={geometry.height * zoom}
          viewBox={`${geometry.minX} ${geometry.minY} ${geometry.width} ${geometry.height}`}
          role="group"
          aria-label={`Graph of ${nodes.length} nodes and ${edges.length} relationships`}
          onPointerDown={(e) => {
            const el = scroller.current;
            if (el) start(e, { kind: 'pan', from: { x: e.clientX, y: e.clientY }, origin: { x: el.scrollLeft, y: el.scrollTop }, moved: false });
          }}
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
          {headings.map((h) => (
            <text key={h.column} className="graph-canvas-column" x={h.x} y={h.y} textAnchor="middle">
              {h.label}
            </text>
          ))}
          {geometry.routes.map((r) => (
            <Connector
              key={r.id}
              route={r}
              edge={byId.get(r.id)!}
              marker={markerId}
              lit={r.id === labelId}
              showLabel={level !== 'dot'}
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
              onLabelReset={() => commit({ ...adjust, labels: without(adjust.labels, r.id), bends: without(adjust.bends, r.id) })}
            />
          ))}
          {tie && <path className="graph-canvas-tie" d={`M${tie.label.x},${tie.label.y} L${tie.anchor.x},${tie.anchor.y}`} />}
          {nodes.map((n) => {
            const b = geometry.boxes.get(n.id)!;
            const root = roots.has(n.id);
            const selected = n.id === selectedId;
            const state = [root && 'root', selected && 'selected', n.state === 'planned' && 'planned', n.group !== undefined && 'group', n.pinned && 'pinned', n.mark && `mark-${n.mark.kind}`, movable && 'movable'].filter(Boolean).join(' ');
            return (
              <g
                key={n.id}
                className={`graph-canvas-node ${state}`}
                transform={`translate(${b.x},${b.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={n.group !== undefined ? `${n.name.replace(/^▸ /, '')}, group, click to open` : `${n.name}, ${n.type}, ${n.layer}${root ? ', root' : ''}${n.pinned ? ', pinned' : ''}${n.state === 'planned' ? ', planned' : ''}${n.mark ? `, ${n.mark.label}` : ''}`}
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
                <NodeBody node={n} level={level} w={b.w} h={b.h} root={root} relationships={degree.get(n.id) ?? 0} />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="graph-canvas-zoom" role="toolbar" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => ((fitted.current = false), zoomTo(zoom / 1.25))}>
          −
        </button>
        <span className="graph-canvas-zoom-value" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => ((fitted.current = false), zoomTo(zoom * 1.25))}>
          +
        </button>
        <span className="graph-canvas-zoom-sep" aria-hidden="true" />
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={level === l.id}
            title={`${l.label} level`}
            onClick={() => {
              fitted.current = false;
              zoomTo(l.zoom);
            }}
          >
            {l.label}
          </button>
        ))}
        <span className="graph-canvas-zoom-sep" aria-hidden="true" />
        {onFollowChange && (
          <button type="button" aria-pressed={follow} title="Keep the selected node centred" onClick={() => onFollowChange(!follow)}>
            Follow selection
          </button>
        )}
        <button type="button" title="Fit the whole result in view" onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  );
}

/** What a node shows at each level of detail (ZM-3). */
function NodeBody({ node: n, level, w, h, root, relationships }: { node: GraphCanvasNode; level: CanvasLevel; w: number; h: number; root: boolean; relationships: number }) {
  if (level === 'dot') return <rect className="graph-canvas-dot" width={w} height={h} rx={4} style={{ fill: layerColor(n.layer) }} />;
  if (level === 'label') {
    return (
      <>
        <rect className="graph-canvas-card" width={w} height={h} rx={h / 2} />
        <circle cx={14} cy={h / 2} r={5} style={{ fill: layerColor(n.layer) }} />
        <text className="graph-canvas-name" x={24} y={h / 2 + 5}>
          {truncate(n.name, Math.floor((w - 30) / 7.5))}
        </text>
      </>
    );
  }
  return (
    <>
      <rect className="graph-canvas-card" width={w} height={h} rx={6} />
      <rect className="graph-canvas-swatch" x={10} y={12} width={10} height={10} rx={2} style={{ fill: layerColor(n.layer) }} />
      <text className="graph-canvas-name" x={28} y={22}>
        {truncate(n.name, n.mark ? 11 : 21)}
      </text>
      {n.mark && (
        <text className="graph-canvas-mark" x={w - 10} y={22} textAnchor="end">
          {truncate(n.mark.label, 12)}
        </text>
      )}
      <text className="graph-canvas-meta" x={10} y={42}>
        {truncate(`${n.type} · ${n.layer}`, root ? 18 : 28)}
      </text>
      {root && (
        <text className="graph-canvas-root" x={w - 10} y={42} textAnchor="end">
          Root
        </text>
      )}
      {level === 'detail' && (
        <>
          <text className="graph-canvas-meta" x={10} y={62}>
            {truncate(`Owner: ${n.owner ?? '–'}`, 28)}
          </text>
          <text className="graph-canvas-meta" x={10} y={80}>
            {truncate(`Changed ${n.changedAt?.slice(0, 10) ?? '–'} · ${relationships} rel.`, 28)}
          </text>
        </>
      )}
    </>
  );
}

interface ConnectorProps {
  route: Route;
  edge: GraphCanvasEdge;
  marker: string;
  /** Its label is selected: the connector is highlighted and tied to the label. */
  lit: boolean;
  showLabel: boolean;
  onLinePointerDown(e: ReactPointerEvent<SVGElement>): void;
  onLabelPointerDown(e: ReactPointerEvent<SVGElement>): void;
  onLabelClick(): void;
  onLabelReset(): void;
}

function Connector({ route, edge, marker, lit, showLabel, onLinePointerDown, onLabelPointerDown, onLabelClick, onLabelReset }: ConnectorProps) {
  const text = edgeLabel(edge.type);
  const { w, h } = labelSize(text);
  const [p, q] = [route.points[0]!, route.points.at(-1)!];
  const d = route.control ? `M${p.x},${p.y} Q${route.control.x},${route.control.y} ${q.x},${q.y}` : route.points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x},${pt.y}`).join(' ');
  const cursor = route.bend ? (route.bend.axis === 'y' ? 'ns' : 'ew') : 'move';
  return (
    <g className={`graph-canvas-edge${edge.planned ? ' planned' : ''}${edge.removed ? ' removed' : ''}${lit ? ' lit' : ''}`} data-edge-id={route.id}>
      <path d={d} markerEnd={`url(#${marker})`} />
      <path className={`graph-canvas-hit ${cursor}`} d={d} onPointerDown={onLinePointerDown} onClick={(e) => e.stopPropagation()}>
        <title>Drag to move this connector</title>
      </path>
      {showLabel && (
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
      )}
    </g>
  );
}

const without = <T,>(rec: Readonly<Record<string, T>>, key: string) => Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));

/** ENABLED_BY → ENABLED BY (GV-3a). */
const edgeLabel = (type: string) => type.replace(/_/g, ' ');

/** The layer's theme token, with the fixed palette, then the System colour, as fallbacks (CT-5). */
const layerColor = (layer: string) => `var(--layer-${layer.toLowerCase()}, ${LAYER_COLORS[layer] ?? 'var(--layer-system, #8d8d8d)'})`;
