import { useMemo } from 'react';
import { canvasOverview, LAYER_COLORS, truncate } from '@d4/render';
import type { GraphCanvasEdge, GraphCanvasNode } from './GraphCanvas';

interface Props {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  /** Types the Show only filter has ticked: marked, the rest dimmed. */
  ticked: readonly string[];
  /** Isolate a type (OV-2): show only it, in the graph. */
  onIsolate?(type: string): void;
}

/**
 * The Overview (OV-1): one bubble per node type, sized by count, with the relationships between
 * types. A table below says the same in words and numbers, so nothing is told by size alone (Q-3).
 * Choosing a type isolates it.
 */
export function GraphCanvasOverview({ nodes, edges, ticked, onIsolate }: Props) {
  const o = useMemo(() => canvasOverview(nodes, edges), [nodes, edges]);
  const at = new Map(o.bubbles.map((b) => [b.type, b]));
  const widest = Math.max(1, ...o.links.map((l) => l.count));
  const linked = (type: string) => o.links.filter((l) => l.a === type || l.b === type).map((l) => (l.a === type ? l.b : l.a));
  const dim = (type: string) => ticked.length > 0 && !ticked.includes(type);

  return (
    <div className="graph-canvas-overview">
      <div className="graph-canvas-scroll">
        <svg
          className="graph-canvas-overview-svg"
          viewBox={`0 0 ${o.width} ${o.height}`}
          width={o.width}
          height={o.height}
          role="group"
          aria-label={`Overview: ${o.bubbles.length} node types and ${o.links.length} kinds of link`}
        >
          {o.links.map((l) => {
            const a = at.get(l.a)!;
            const b = at.get(l.b)!;
            const w = 1 + 5 * Math.sqrt(l.count / widest);
            if (a === b) {
              // A type linked to itself: a loop above its bubble.
              const d = `M${a.x - a.r * 0.5},${a.y - a.r * 0.85} C${a.x - a.r},${a.y - a.r * 2} ${a.x + a.r},${a.y - a.r * 2} ${a.x + a.r * 0.5},${a.y - a.r * 0.85}`;
              return (
                <g key={`${l.a}|${l.b}`} className="graph-canvas-overview-link">
                  <path d={d} style={{ strokeWidth: w }} />
                  <text x={a.x} y={a.y - a.r * 1.55} textAnchor="middle">
                    {l.count}
                  </text>
                </g>
              );
            }
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const ux = (b.x - a.x) / len;
            const uy = (b.y - a.y) / len;
            const p = { x: a.x + ux * a.r, y: a.y + uy * a.r };
            const q = { x: b.x - ux * b.r, y: b.y - uy * b.r };
            return (
              <g key={`${l.a}|${l.b}`} className="graph-canvas-overview-link">
                <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} style={{ strokeWidth: w }} />
                <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 4} textAnchor="middle">
                  {l.count}
                </text>
              </g>
            );
          })}
          {o.bubbles.map((b) => (
            <g
              key={b.type}
              className={`graph-canvas-bubble${dim(b.type) ? ' dim' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${b.type}, ${b.layer}: ${b.count} ${b.count === 1 ? 'node' : 'nodes'}. Isolate`}
              data-type={b.type}
              onClick={() => onIsolate?.(b.type)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onIsolate?.(b.type);
                }
              }}
            >
              <title>{`Isolate ${b.type}`}</title>
              <circle cx={b.x} cy={b.y} r={b.r} style={{ fill: layerColor(b.layer) }} />
              <text className="graph-canvas-bubble-name" x={b.x} y={b.y - 2} textAnchor="middle">
                {truncate(b.type, Math.max(4, Math.floor(b.r / 4)))}
              </text>
              <text className="graph-canvas-bubble-count" x={b.x} y={b.y + 14} textAnchor="middle">
                {b.count.toLocaleString()}
              </text>
            </g>
          ))}
        </svg>
        <table className="graph-canvas-overview-table">
          <caption>Node types in this result</caption>
          <thead>
            <tr>
              <th scope="col">Node type</th>
              <th scope="col">Layer</th>
              <th scope="col">Nodes</th>
              <th scope="col">Linked to</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {o.bubbles.map((b) => (
              <tr key={b.type}>
                <th scope="row">{b.type}</th>
                <td>{b.layer}</td>
                <td className="num">{b.count.toLocaleString()}</td>
                <td>{linked(b.type).join(', ') || '–'}</td>
                <td>
                  {onIsolate && (
                    <button type="button" className="button ghost small" aria-label={`Isolate ${b.type}`} onClick={() => onIsolate(b.type)}>
                      Isolate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const layerColor = (layer: string) => `var(--layer-${layer.toLowerCase()}, ${LAYER_COLORS[layer] ?? 'var(--layer-system, #8d8d8d)'})`;
