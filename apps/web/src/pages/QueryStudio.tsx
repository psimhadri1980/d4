import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, can, catalogApi, type CatalogEntry, type Checks, type QueryVersion } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { RemoveQueryButton } from '../components/RemoveQueryButton';
import { TestRunPanel } from '../components/TestRunPanel';

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  deprecated: 'Deprecated',
  retired: 'Retired',
};

const PARAMS_EXAMPLE = `[
  { "name": "element", "type": "element", "required": true, "label": "Application", "elementTypes": ["Application"] },
  { "name": "asOf", "type": "date", "label": "Valid on" }
]`;

const STARTER = `MATCH (n:Application)
WHERE n.workspaceId = $workspace AND n.deleted = false
RETURN n.name AS name, n.lifecycle AS lifecycle
ORDER BY name
LIMIT 100`;

/** Authors write, check and submit catalog queries. Cypher never runs from here. */
export function QueryStudio() {
  const { ws, qid } = useParams();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const list = useQuery({ queryKey: ['catalog', 'studio'], queryFn: () => catalogApi.search() });

  if (me.data && !can(me.data.roles).author) {
    return <div className="splash">The Query Studio is for users with the query-author role.</div>;
  }

  return (
    <div className="catalog">
      <aside className="pane left">
        <h3>Query Studio</h3>
        <NewQueryForm workspaceId={ws!} />
        {list.error && <ErrorBanner error={list.error} />}
        <ul className="items">
          {(list.data ?? []).map((e) => (
            <li key={e.id} className={e.id === qid ? 'selected' : ''}>
              <Link to={`/w/${ws}/studio/${e.id}`}>
                <span className="name">{e.title}</span>
                <StatusBadges entry={e} />
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <section className="pane main">
        {qid ? <Editor key={qid} queryId={qid} /> : <div className="empty">Pick a query to edit, or create a new one.</div>}
      </section>
    </div>
  );
}

export function StatusBadges({ entry }: { entry: CatalogEntry }) {
  return (
    <span className="status-badges">
      {entry.system && <span className="badge muted">system</span>}
      {entry.openStatus && <span className={`badge st-${entry.openStatus}`}>{STATUS_LABEL[entry.openStatus]}</span>}
      {entry.publishedVersion !== null && <span className="badge st-published">v{entry.publishedVersion}</span>}
    </span>
  );
}

function NewQueryForm({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<unknown>(null);

  const suggested = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const created = await catalogApi.create({
        title,
        slug: slug || suggested,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      setOpen(false);
      navigate(`/w/${workspaceId}/studio/${created.id}`);
    } catch (err) {
      setError(err);
    }
  };

  if (!open) {
    return (
      <button className="button primary" onClick={() => setOpen(true)}>
        + New query
      </button>
    );
  }
  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="nq-title">Title *</label>
        <input id="nq-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="nq-slug">Slug</label>
        <input id="nq-slug" placeholder={suggested} value={slug} onChange={(e) => setSlug(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="nq-tags">Tags</label>
        <input id="nq-tags" placeholder="comma, separated" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <ErrorBanner error={error} />
      <div className="actions">
        <button className="button primary" type="submit" disabled={!title}>
          Create
        </button>
        <button type="button" className="button ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Editor({ queryId }: { queryId: string }) {
  const { ws } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['catalog-detail', queryId], queryFn: () => catalogApi.detail(queryId) });
  const [cypher, setCypher] = useState('');
  const [paramsText, setParamsText] = useState('[]');
  const [shape, setShape] = useState<'table' | 'graph'>('table');
  const [checks, setChecks] = useState<Checks | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const versions = detail.data?.versions ?? [];
  const open = versions.find((v) => v.status === 'draft' || v.status === 'in_review');
  const published = versions.find((v) => v.status === 'published');

  // Start from the open draft, else the published version, else a starter query.
  useEffect(() => {
    const base = open ?? published;
    setCypher(base?.cypher ?? STARTER);
    setParamsText(JSON.stringify(base?.params ?? [], null, 2));
    setShape(base?.resultShape ?? 'table');
    setChecks(open?.checks ?? null);
  }, [open?.id, published?.id]);

  if (detail.error) return <ErrorBanner error={detail.error} />;
  const d = detail.data;
  if (!d) return <div className="muted">Loading…</div>;
  if (d.system) {
    return (
      <div className="card">
        <h2>{d.title}</h2>
        <p className="muted">System queries ship with the platform and cannot be edited here.</p>
        {published && <pre className="cypher">{published.cypher}</pre>}
      </div>
    );
  }

  const inReview = open?.status === 'in_review';
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['catalog'] }).then(() => queryClient.invalidateQueries({ queryKey: ['catalog-detail', queryId] }));

  const save = async () => {
    setError(null);
    let params: unknown;
    try {
      params = JSON.parse(paramsText);
      if (!Array.isArray(params)) throw new Error('Parameters must be a JSON array');
    } catch (e) {
      setError(new Error(`Parameters are not valid JSON: ${(e as Error).message}`));
      return;
    }
    setBusy(true);
    try {
      const res = await catalogApi.saveDraft(queryId, { cypher, params: params as unknown[], resultShape: shape });
      setChecks(res.checks);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await catalogApi.submit(queryId);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio">
      <div className="card">
        <div className="eyebrow">{d.tags.join(' · ') || 'no tags'}</div>
        <h2>{d.title}</h2>
        <StatusBadges entry={{ ...d, openStatus: (open?.status as 'draft' | 'in_review' | undefined) ?? null, publishedVersion: published?.version ?? null }} />
        {open?.reviewNote && open.status === 'draft' && (
          <div className="note" role="note">
            <strong>Sent back by the steward:</strong> {open.reviewNote}
          </div>
        )}
        {inReview && <p className="muted">Version {open!.version} is waiting for a steward; it can't be edited until reviewed.</p>}

        <div className="field">
          <label htmlFor="cypher">Cypher</label>
          <textarea id="cypher" className="code" rows={12} value={cypher} onChange={(e) => setCypher(e.target.value)} disabled={inReview} spellCheck={false} />
          <small className="muted">Must filter by <code>$workspace</code>; read-only; only allow-listed procedures.</small>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="params">Parameters (JSON)</label>
            <textarea id="params" className="code" rows={8} value={paramsText} onChange={(e) => setParamsText(e.target.value)} disabled={inReview} spellCheck={false} />
          </div>
          <div className="field">
            <label>Example</label>
            <pre className="cypher small">{PARAMS_EXAMPLE}</pre>
            <label htmlFor="shape">Result</label>
            <select id="shape" value={shape} onChange={(e) => setShape(e.target.value as 'table' | 'graph')} disabled={inReview}>
              <option value="table">Table</option>
              <option value="graph">Graph</option>
            </select>
          </div>
        </div>

        {checks && <ChecksList checks={checks} />}
        <ErrorBanner error={error} />
        <div className="actions">
          <button className="button" onClick={() => void save()} disabled={busy || inReview}>
            Save draft
          </button>
          <button
            className="button primary"
            onClick={() => void submit()}
            disabled={busy || inReview || open?.status !== 'draft' || !!checks?.errors.length}
            title={checks?.errors.length ? 'Fix the errors first' : undefined}
          >
            Submit for review
          </button>
          <div className="spacer" />
          <RemoveQueryButton queryId={queryId} title={d.title} versions={versions} after={`/w/${ws}/studio`} />
        </div>
      </div>
      {open && !open.checks?.errors.length && open.checks && (
        <TestRunPanel key={`${open.id}-${open.contentHash}`} workspaceId={ws!} queryId={queryId} version={open} title={d.slug} />
      )}
      <VersionHistory versions={versions} />
    </div>
  );
}

export function ChecksList({ checks }: { checks: Checks }) {
  if (!checks.errors.length && !checks.warnings.length) {
    return <div className="checks ok">✓ All checks pass</div>;
  }
  return (
    <div className="checks">
      {checks.errors.map((e) => (
        <div key={e} className="check error">
          ✗ {e}
        </div>
      ))}
      {checks.warnings.map((w) => (
        <div key={w} className="check warning">
          ! {w}
        </div>
      ))}
    </div>
  );
}

export function VersionHistory({ versions }: { versions: QueryVersion[] }) {
  if (!versions.length) return null;
  return (
    <div className="card">
      <h3>Versions</h3>
      <ol className="history">
        {versions.map((v) => (
          <li key={v.id}>
            <strong>v{v.version}</strong> <span className={`badge st-${v.status}`}>{STATUS_LABEL[v.status]}</span>{' '}
            <span className="muted small">
              {v.publishedAt ? `published ${new Date(v.publishedAt).toLocaleDateString()}` : `created ${new Date(v.createdAt).toLocaleDateString()}`}
            </span>
            {v.reviewNote && <div className="small">Note: {v.reviewNote}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
