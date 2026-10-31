import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryResultView } from './QueryResultView';
import { api } from '@d4/web-platform';
import { catalogApi } from './api';
import { ErrorBanner, missingRequired, ParamForm, paramLabel, paramsFromForm, type ParamValues } from '@d4/ui-kit';

/** Run a published catalog query: parameter form, results, Cypher. */
export function RunPanel({ workspaceId, queryId }: { workspaceId: string; queryId: string }) {
  const detail = useQuery({ queryKey: ['catalog-detail', queryId], queryFn: () => catalogApi.detail(queryId) });
  const [values, setValues] = useState<ParamValues>({});
  const [showCypher, setShowCypher] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);

  const published = detail.data?.versions.find((v) => v.status === 'published');
  const run = useMutation({
    mutationFn: () => api.runQuery(workspaceId, queryId, paramsFromForm(published?.params ?? [], values)),
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
          <QueryResultView result={run.data} workspaceId={workspaceId} title={d.slug} shape={published?.resultShape ?? 'table'} />
        </div>
      )}
    </div>
  );
}
