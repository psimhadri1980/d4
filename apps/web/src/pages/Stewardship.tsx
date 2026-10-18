import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useParams } from 'react-router-dom';
import { catalogApi, type QueryGrant, type QueryVersion } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { RemoveQueryButton } from '../components/RemoveQueryButton';
import { TestRunPanel } from '../components/TestRunPanel';
import { ChecksList, STATUS_LABEL, VersionHistory } from './QueryStudio';

/** Roles a steward can grant a query to (mirrors the platform role list). */
const GRANTABLE_ROLES = ['viewer', 'contributor', 'planner', 'architect', 'query-author', 'query-steward'];

/** Stewards review submissions and manage grants, certification and version lifecycle. */
export function StewardPanel({ queryId, onRemoved }: { queryId: string; onRemoved(): void }) {
  const { ws } = useParams();
  const uid = useId();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['catalog-detail', queryId], queryFn: () => catalogApi.detail(queryId) });
  const runs = useQuery({ queryKey: ['executions', queryId], queryFn: () => catalogApi.executions(queryId) });
  const [note, setNote] = useState('');
  const [grants, setGrants] = useState<QueryGrant[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => setGrants(detail.data?.grants ?? []), [detail.data?.grants]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['catalog'] });
    await queryClient.invalidateQueries({ queryKey: ['catalog-detail', queryId] });
  };
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setSaved('');
    try {
      await fn();
      await refresh();
      setSaved(label);
    } catch (e) {
      setError(e);
    }
  };

  if (detail.error) return <ErrorBanner error={detail.error} />;
  const d = detail.data;
  if (!d) return <div className="muted">Loading…</div>;

  const pending = d.versions.find((v) => v.status === 'in_review');
  const published = d.versions.find((v) => v.status === 'published');
  const hasRole = (r: string) => grants.some((g) => g.principalType === 'role' && g.principal === r);
  const toggleRole = (r: string) =>
    setGrants((gs) =>
      hasRole(r) ? gs.filter((g) => !(g.principalType === 'role' && g.principal === r)) : [...gs, { principalType: 'role', principal: r }],
    );

  return (
    <div className="studio">
      <div className="card">
        <div className="eyebrow">{d.tags.join(' · ')}</div>
        <h2>
          {d.title} {d.certified && <span className="badge certified">certified</span>}
        </h2>
        {d.description && <p>{d.description}</p>}
        <ErrorBanner error={error} />
        {saved && <div className="checks ok">✓ {saved}</div>}
      </div>

      {pending && (
        <div className="card">
          <h3>Review v{pending.version}</h3>
          <p className="muted small">Submitted {pending.submittedAt ? new Date(pending.submittedAt).toLocaleString() : ''}</p>
          <div className={published ? 'compare' : ''}>
            <div>
              <div className="rel-label">Submitted</div>
              <pre className="cypher">{pending.cypher}</pre>
              <pre className="cypher small">{JSON.stringify(pending.params, null, 2)}</pre>
            </div>
            {published && (
              <div>
                <div className="rel-label">Currently published (v{published.version})</div>
                <pre className="cypher">{published.cypher}</pre>
                <pre className="cypher small">{JSON.stringify(published.params, null, 2)}</pre>
              </div>
            )}
          </div>
          {pending.checks && <ChecksList checks={pending.checks} />}
          <div className="field">
            <label htmlFor={`${uid}review-note`}>Note to the author</label>
            <textarea id={`${uid}review-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="actions">
            <button className="button primary" onClick={() => void act('Published', () => catalogApi.review(queryId, 'publish', note || undefined))}>
              Publish
            </button>
            <button className="button" onClick={() => void act('Sent back to the author', () => catalogApi.review(queryId, 'reject', note || undefined))}>
              Send back
            </button>
          </div>
        </div>
      )}

      {pending && <TestRunPanel key={pending.id} workspaceId={ws!} queryId={queryId} version={pending} title={d.slug} />}

      <div className="card">
        <h3>Who can run it</h3>
        <div className="role-grid">
          {GRANTABLE_ROLES.map((r) => (
            <label key={r} className="inline">
              <input type="checkbox" aria-label={`Grant to ${r}`} checked={hasRole(r)} onChange={() => toggleRole(r)} /> {r}
            </label>
          ))}
        </div>
        {grants.some((g) => g.principalType === 'group') && (
          <p className="muted small">Also granted to {grants.filter((g) => g.principalType === 'group').length} group(s).</p>
        )}
        <div className="actions">
          <button className="button" onClick={() => void act('Grants saved', () => catalogApi.setGrants(queryId, grants))}>
            Save grants
          </button>
          {!d.system && (
            <button className="button ghost" onClick={() => void act(d.certified ? 'Certification removed' : 'Certified', () => catalogApi.updateMeta(queryId, { certified: !d.certified }))}>
              {d.certified ? 'Remove certification' : 'Certify'}
            </button>
          )}
          <div className="spacer" />
          {!d.system && <RemoveQueryButton queryId={queryId} title={d.title} versions={d.versions} onRemoved={onRemoved} />}
        </div>
      </div>

      <div className="card">
        <h3>Version lifecycle</h3>
        <ul className="history">
          {d.versions.map((v: QueryVersion) => (
            <li key={v.id}>
              <strong>v{v.version}</strong> <span className={`badge st-${v.status}`}>{STATUS_LABEL[v.status]}</span>{' '}
              {v.status === 'published' && (
                <button className="button small" onClick={() => void act(`v${v.version} deprecated`, () => catalogApi.setVersionStatus(queryId, v.version, 'deprecated'))}>
                  Deprecate
                </button>
              )}
              {v.status === 'deprecated' && (
                <>
                  <button className="button small" onClick={() => void act(`v${v.version} re-published`, () => catalogApi.setVersionStatus(queryId, v.version, 'published'))}>
                    Re-publish
                  </button>{' '}
                  <button className="button small danger" onClick={() => void act(`v${v.version} retired`, () => catalogApi.setVersionStatus(queryId, v.version, 'retired'))}>
                    Retire
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Recent runs</h3>
        {runs.error && <ErrorBanner error={runs.error} />}
        {runs.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.seq}>
                    <td>{new Date(r.executedAt).toLocaleString()}</td>
                    <td>v{r.version}</td>
                    <td className={r.status === 'ok' ? '' : 'danger-text'}>{r.status}</td>
                    <td>{r.rowCount ?? '—'}</td>
                    <td>{r.durationMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">No runs yet.</p>
        )}
      </div>
      <VersionHistory versions={d.versions} />
    </div>
  );
}
