import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { GraphCanvasEdge, GraphCanvasNode } from './GraphCanvas';

export interface GraphInspectorProps {
  registry: MetamodelRegistry;
  /** The selected node; null shows the hint (DP-3). */
  node: GraphCanvasNode | null;
  /** The selected element's attribute values. */
  attrs?: Record<string, unknown>;
  /** The loaded result, for the direct relationships (DP-5). */
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  onSelect?(id: string): void;
  /** Where the element editor is (DP-4: the panel itself is read-only). */
  editTo?: string;
  /** Focus on this node: drill down to it (DD-1). */
  onFocus?(id: string): void;
  /** Keep this node on the canvas, or let it go (D85). */
  onPin?(id: string): void;
  /** Pinned nodes to offer "How is it connected to…?" for (D89), the selected one left out. */
  connectTo?: readonly { id: string; name: string }[];
  onConnect?(fromId: string, toId: string): void;
  /** Lenses that start from a node of this type, for "Open as" (D92): runs one with this node as its root. */
  openAs?: readonly { id: string; name: string }[];
  onOpenAs?(id: string, lensId: string): void;
}

/**
 * The details panel beside both views of GraphCanvas (DP-1…DP-5): the selected element's name,
 * type and layer, every attribute its type defines (a dash when empty) plus any others it carries,
 * and its direct relationships in the result.
 */
export function GraphInspector({ registry, node, attrs = {}, nodes, edges, onSelect, editTo, onFocus, onPin, connectTo = [], onConnect, openAs = [], onOpenAs }: GraphInspectorProps) {
  const headingId = useId();
  const openAsId = useId();
  if (!node) {
    return (
      <aside className="graph-inspector" aria-label="Inspector">
        <p className="graph-inspector-empty">Select a node to see its attributes</p>
      </aside>
    );
  }

  const defined = registry.attributesFor(node.type).filter((d) => d.name !== 'name');
  const known = new Set(defined.map((d) => d.name));
  const extra = Object.keys(attrs)
    .filter((k) => k !== 'name' && !known.has(k))
    .sort();
  const names = new Map(nodes.map((n) => [n.id, n.name]));
  const links = edges
    .filter((e) => e.from === node.id || e.to === node.id)
    .map((e) => ({ e, out: e.from === node.id, other: e.from === node.id ? e.to : e.from }))
    .sort((a, b) => a.e.type.localeCompare(b.e.type) || (names.get(a.other) ?? '').localeCompare(names.get(b.other) ?? ''));

  return (
    <aside className="graph-inspector" aria-labelledby={headingId}>
      <header className="graph-inspector-head">
        <h2 id={headingId}>{node.name}</h2>
        <p>
          {node.type} · {node.layer}
          {node.state === 'planned' ? ' · planned' : ''}
        </p>
        <div className="graph-inspector-actions">
          {onFocus && (
            <button type="button" className="button small" onClick={() => onFocus(node.id)}>
              Focus on this node
            </button>
          )}
          {onPin && (
            <button type="button" className="button small ghost" aria-pressed={!!node.pinned} onClick={() => onPin(node.id)}>
              {node.pinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {onConnect &&
            connectTo
              .filter((t) => t.id !== node.id)
              .map((t) => (
                <button key={t.id} type="button" className="button small ghost" onClick={() => onConnect(node.id, t.id)}>
                  How is it connected to {t.name}?
                </button>
              ))}
          {onOpenAs && openAs.length > 0 && (
            <span className="graph-inspector-open-as">
              <label htmlFor={openAsId}>Open as</label>
              <select id={openAsId} value="" onChange={(e) => e.target.value && onOpenAs(node.id, e.target.value)}>
                <option value="">Choose a lens…</option>
                {openAs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </span>
          )}
          {editTo && <Link to={editTo}>Edit in the element editor</Link>}
        </div>
      </header>
      <dl className="graph-inspector-attrs">
        {[...defined.map((d) => d.name), ...extra].map((k) => (
          <div key={k}>
            <dt>
              {attributeLabel(k)}
              {!known.has(k) && <span className="graph-inspector-extra"> (not in the metamodel)</span>}
            </dt>
            <dd>{formatValue(attrs[k])}</dd>
          </div>
        ))}
      </dl>
      <section className="graph-inspector-links" aria-label="Relationships">
        <h3>Relationships ({links.length})</h3>
        {links.length ? (
          <ul>
            {links.map(({ e, out, other }, i) => (
              <li key={`${e.type}|${other}|${i}`}>
                <span className="graph-inspector-dir" aria-label={out ? 'outgoing' : 'incoming'}>
                  {out ? '→' : '←'}
                </span>{' '}
                <span className="graph-inspector-type">{e.type.replace(/_/g, ' ')}</span>{' '}
                <button type="button" className="link" onClick={() => onSelect?.(other)}>
                  {names.get(other) ?? other}
                </button>
                {e.planned && <span className="graph-inspector-planned"> planned</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="graph-inspector-empty">None in this result.</p>
        )}
      </section>
    </aside>
  );
}

/** targetDate → Target date. */
export const attributeLabel = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatValue = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '–';
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : '–';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};
