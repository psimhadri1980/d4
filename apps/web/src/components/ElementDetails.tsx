import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MetamodelRegistry } from '@d4/metamodel';
import { api, type Connection } from '../api';
import { useView, viewQuery } from '../view';
import { elementName, layerOf, layerVar } from '../model';
import { ErrorBanner } from './ErrorBanner';
import { RelationshipForm } from './RelationshipForm';

interface Props {
  registry: MetamodelRegistry;
  workspaceId: string;
  elementId: string;
}

const HIDDEN = new Set(['name', 'description', 'lifecycle']);

export function ElementDetails({ registry, workspaceId: ws, elementId: id }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const element = useQuery({ queryKey: ['element', ws, id], queryFn: () => api.element(ws, id) });
  const { view } = useView();
  const vq = viewQuery(view);
  const connections = useQuery({ queryKey: ['connections', ws, id, vq], queryFn: () => api.connections(ws, id, vq) });
  const history = useQuery({ queryKey: ['history', ws, id], queryFn: () => api.history(ws, id) });

  const refresh = () => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === ws });

  if (element.error) return <ErrorBanner error={element.error} />;
  const e = element.data;
  if (!e) return <div className="muted">Loading…</div>;

  const layer = layerOf(registry, e.type);
  const attrs = registry.attributesFor(e.type).filter((d) => !HIDDEN.has(d.name) && e.attrs[d.name] !== undefined);

  const remove = async () => {
    if (!window.confirm(`Delete "${elementName(e)}" and its relationships?`)) return;
    try {
      await api.deleteElement(ws, e.id, e.version);
      await refresh();
      navigate(`/w/${ws}`);
    } catch (err) {
      setError(err);
    }
  };

  const unlink = async (c: Connection) => {
    if (!window.confirm(`Remove ${c.relationship.type} to "${elementName(c.other)}"?`)) return;
    try {
      await api.deleteRelationship(ws, c.relationship.id, c.relationship.version);
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  // Group connections by "TYPE →" / "← TYPE".
  const groups = new Map<string, Connection[]>();
  for (const c of connections.data ?? []) {
    const label = c.relationship.fromId === e.id ? `${c.relationship.type} →` : `← ${c.relationship.type}`;
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }

  return (
    <div className="details">
      <div className="card">
        <div className="eyebrow">
          <span className="dot" style={{ background: layerVar(layer) }} />
          {layer} · {e.type}
        </div>
        <h2>{elementName(e)}</h2>
        <div className="badges">
          {typeof e.attrs['lifecycle'] === 'string' && (
            <span className={`badge lc-${String(e.attrs['lifecycle']).toLowerCase()}`}>{String(e.attrs['lifecycle'])}</span>
          )}
          <span className="badge muted">v{e.version}</span>
          {(e.validFrom || e.validTo) && (
            <span className="badge muted">
              {e.validFrom ?? '…'} → {e.validTo ?? '…'}
            </span>
          )}
        </div>
        {typeof e.attrs['description'] === 'string' && <p>{String(e.attrs['description'])}</p>}
        {attrs.length > 0 && (
          <dl className="attrs">
            {attrs.map((d) => (
              <div key={d.name}>
                <dt>{d.name}</dt>
                <dd>{Array.isArray(e.attrs[d.name]) ? (e.attrs[d.name] as string[]).join(', ') : String(e.attrs[d.name])}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="actions">
          <Link className="button" to={`/w/${ws}/e/${e.id}/edit`}>
            Edit
          </Link>
          <button className="button danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
        <ErrorBanner error={error} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Relationships</h3>
          <button className="button small" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : '+ Add'}
          </button>
        </div>
        {adding && (
          <RelationshipForm
            registry={registry}
            workspaceId={ws}
            element={e}
            onDone={async () => {
              setAdding(false);
              await refresh();
            }}
          />
        )}
        {connections.error && <ErrorBanner error={connections.error} />}
        {!groups.size && !connections.isLoading && <div className="muted small">No relationships yet.</div>}
        {[...groups.entries()].map(([label, list]) => (
          <div key={label} className="rel-group">
            <div className="rel-label">{label}</div>
            <ul>
              {list.map((c) => (
                <li key={c.relationship.id}>
                  <span className="dot" style={{ background: layerVar(layerOf(registry, c.other.type)) }} />
                  <Link to={`/w/${ws}/e/${c.other.id}`}>{elementName(c.other)}</Link>
                  <span className="muted small"> {c.other.type}</span>
                  {Object.keys(c.relationship.attrs).length > 0 && (
                    <span className="small"> · {Object.entries(c.relationship.attrs).map(([k, v]) => `${k}=${String(v)}`).join(', ')}</span>
                  )}
                  {(c.relationship.validFrom || c.relationship.validTo) && (
                    <span className="muted small">
                      {' '}
                      ({c.relationship.validFrom ?? '…'} → {c.relationship.validTo ?? '…'})
                    </span>
                  )}
                  {c.relationship.scenarioId && (
                    <span className="badge scenario" title="Belongs to the selected scenario">
                      scenario
                    </span>
                  )}
                  <button className="link danger" title="Remove relationship" onClick={() => void unlink(c)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>History</h3>
        <ol className="history">
          {[...(history.data ?? [])].reverse().map((ev) => (
            <li key={ev.id}>
              <div>
                <strong>{ev.type.replace(/^Element/, '')}</strong>{' '}
                <span className="muted small">
                  v{ev.version} · {new Date(ev.occurredAt).toLocaleString()}
                  {ev.data['source'] === 'import' && ' · import'}
                </span>
              </div>
              {ev.type === 'ElementUpdated' && (
                <ul className="small">
                  {Object.entries(ev.data['changes'] as Record<string, { from: unknown; to: unknown }>).map(([k, ch]) => (
                    <li key={k}>
                      {k.replace(/^attrs\./, '')}: {JSON.stringify(ch.from)} → {JSON.stringify(ch.to)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
