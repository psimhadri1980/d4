import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Element, type Relationship } from '../api';
import { ElementDetails } from '../components/ElementDetails';
import { ElementList } from '../components/ElementList';
import { ErrorBanner } from '../components/ErrorBanner';
import { GraphCanvas } from '../components/GraphCanvas';
import { useRegistry } from '../model';

/**
 * Three panes: find elements (left), see them in context (graph), inspect and change (right).
 * Selecting an element loads its neighbourhood; double-clicking a node merges that node's
 * neighbourhood into the view so users can walk the graph.
 */
export function Explorer() {
  const { ws, id } = useParams();
  const navigate = useNavigate();
  const registry = useRegistry(ws);
  const [depth, setDepth] = useState(1);
  const [extra, setExtra] = useState<{ elements: Element[]; relationships: Relationship[] }>({
    elements: [],
    relationships: [],
  });

  const hood = useQuery({
    queryKey: ['neighbourhood', ws, id, depth],
    enabled: !!ws && !!id,
    queryFn: () => api.neighbourhood(ws!, id!, depth),
  });

  // A new focus element starts a fresh view.
  useEffect(() => setExtra({ elements: [], relationships: [] }), [id, ws]);

  const view = useMemo(() => {
    const elements = new Map<string, Element>();
    const relationships = new Map<string, Relationship>();
    if (hood.data) {
      elements.set(hood.data.root.id, hood.data.root);
      for (const e of hood.data.elements) elements.set(e.id, e);
      for (const r of hood.data.relationships) relationships.set(r.id, r);
    }
    for (const e of extra.elements) elements.set(e.id, e);
    for (const r of extra.relationships) relationships.set(r.id, r);
    return { elements: [...elements.values()], relationships: [...relationships.values()] };
  }, [hood.data, extra]);

  const expand = async (nodeId: string) => {
    const sub = await api.neighbourhood(ws!, nodeId, 1);
    setExtra((x) => ({
      elements: [...x.elements, sub.root, ...sub.elements],
      relationships: [...x.relationships, ...sub.relationships],
    }));
  };

  if (registry.error) return <ErrorBanner error={registry.error} />;
  if (!registry.data) return <div className="splash">Loading metamodel…</div>;

  return (
    <div className="explorer">
      <aside className="pane left">
        <ElementList registry={registry.data} workspaceId={ws!} selectedId={id} />
      </aside>

      <section className="pane center">
        <div className="toolbar">
          <span className="muted">
            {id
              ? `${view.elements.length} elements · ${view.relationships.length} relationships`
              : 'Select an element to see its neighbourhood'}
            {hood.data?.truncated && ' · truncated'}
          </span>
          <div className="spacer" />
          <label className="inline">
            Depth
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} disabled={!id}>
              {[1, 2, 3].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <span className="muted small">Double-click a node to expand it</span>
        </div>
        {hood.error && <ErrorBanner error={hood.error} />}
        {id ? (
          <GraphCanvas
            registry={registry.data}
            elements={view.elements}
            relationships={view.relationships}
            selectedId={id}
            onSelect={(nodeId) => navigate(`/w/${ws}/e/${nodeId}`)}
            onExpand={(nodeId) => void expand(nodeId)}
          />
        ) : (
          <div className="empty">
            <p>Pick an element on the left, or create one.</p>
          </div>
        )}
      </section>

      <aside className="pane right">
        {id ? (
          <ElementDetails registry={registry.data} workspaceId={ws!} elementId={id} />
        ) : (
          <Legend layers={registry.data.metamodel.layers} />
        )}
      </aside>
    </div>
  );
}

function Legend({ layers }: { layers: string[] }) {
  return (
    <div className="card">
      <h3>Layers</h3>
      <ul className="legend">
        {layers
          .filter((l) => l !== 'System')
          .map((l) => (
            <li key={l}>
              <span className="dot" style={{ background: `var(--layer-${l.toLowerCase()})` }} />
              {l}
            </li>
          ))}
      </ul>
    </div>
  );
}
