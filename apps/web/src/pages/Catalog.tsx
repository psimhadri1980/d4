import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, can, catalogApi, type CatalogEntry } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { missingRequired, ParamForm, paramLabel, paramsFromForm, type ParamValues } from '../components/ParamForm';
import { QueryResultView } from '../components/QueryResultView';

/** Browse and run the queries you are allowed to run. */
export function Catalog() {
  const { ws, qid } = useParams();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const roles = can(me.data?.roles);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const list = useQuery({ queryKey: ['catalog', q, tag], queryFn: () => catalogApi.search({ q: q || undefined, tag: tag || undefined }) });
  // Users run published queries; authors and stewards also see unpublished ones in their own screens.
  const runnable = (list.data ?? []).filter((e) => e.publishedVersion !== null);
  const tags = useMemo(() => [...new Set((list.data ?? []).flatMap((e) => e.tags))].sort(), [list.data]);

  return (
    <div className="catalog">
      <aside className="pane left">
        <h3>Query catalog</h3>
        <input type="search" placeholder="Search queries…" aria-label="Search queries" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {list.error && <ErrorBanner error={list.error} />}
        <ul className="items">
          {runnable.map((e) => (
            <li key={e.id} className={e.id === qid ? 'selected' : ''}>
              <Link to={`/w/${ws}/catalog/${e.id}`}>
                <span className="name">{e.title}</span>
                {e.certified && <span className="badge certified" title="Certified by a steward">✓</span>}
              </Link>
            </li>
          ))}
        </ul>
        {!list.isLoading && !runnable.length && <p className="muted small">No queries match.</p>}
        {roles.author && (
          <Link className="button" to={`/w/${ws}/studio`}>
            Open Query Studio
          </Link>
        )}
      </aside>
      <section className="pane main">
        {qid ? (
          <RunPanel key={qid} workspaceId={ws!} queryId={qid} entry={runnable.find((e) => e.id === qid)} />
        ) : (
          <div className="empty">
            <p>Choose a query on the left to run it against this workspace.</p>
            {runnable[0] && (
              <button className="button" onClick={() => navigate(`/w/${ws}/catalog/${runnable[0]!.id}`)}>
                Open “{runnable[0].title}”
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function RunPanel({ workspaceId, queryId, entry }: { workspaceId: string; queryId: string; entry?: CatalogEntry }) {
  const detail = useQuery({ queryKey: ['catalog-detail', queryId], queryFn: () => catalogApi.detail(queryId) });
  const [values, setValues] = useState<ParamValues>({});
  const [showCypher, setShowCypher] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);

  const published = detail.data?.versions.find((v) => v.status === 'published');
  const run = useMutation({
    mutationFn: () => catalogApi.run(workspaceId, queryId, paramsFromForm(published?.params ?? [], values)),
  });

  if (detail.error) return <ErrorBanner error={detail.error} />;
  const d = detail.data;
  if (!d) return <div className="muted">Loading…</div>;

  return (
    <div className="run-panel">
      <div className="card">
        <div className="eyebrow">
          {d.tags.join(' · ')}
          {d.system && ' · system'}
        </div>
        <h2>
          {d.title} {d.certified && <span className="badge certified">certified</span>}
        </h2>
        {d.description && <p>{d.description}</p>}
        {!published ? (
          <p className="muted">This query has no published version.</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const gaps = missingRequired(published.params, values).map(paramLabel);
              setMissing(gaps);
              if (!gaps.length) run.mutate();
            }}
          >
            <ParamForm workspaceId={workspaceId} defs={published.params} values={values} onChange={setValues} />
            <div className="actions">
              <button className="button primary" type="submit" disabled={run.isPending}>
                {run.isPending ? 'Running…' : 'Run'}
              </button>
              <button type="button" className="button ghost" onClick={() => setShowCypher((s) => !s)}>
                {showCypher ? 'Hide Cypher' : 'Show Cypher'}
              </button>
              <span className="muted small">v{published.version}</span>
            </div>
            {missing.length > 0 && (
              <div className="error-banner" role="alert">
                Please fill in: {missing.join(', ')}
              </div>
            )}
            {showCypher && <pre className="cypher">{published.cypher}</pre>}
          </form>
        )}
        <ErrorBanner error={run.error} />
      </div>
      {run.data && (
        <div className="card">
          <QueryResultView result={run.data} workspaceId={workspaceId} title={entry?.slug ?? d.slug} shape={published?.resultShape ?? 'table'} />
        </div>
      )}
    </div>
  );
}
