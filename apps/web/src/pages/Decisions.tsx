import type { DecisionRecord, DecisionRef } from '@d4/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { ViewBar, ViewNotice } from '../components/ViewBar';
import { useView, viewQuery } from '../view';

const STATUSES = ['PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'];

/**
 * The decision log: architecture decision records newest first, with their context, options,
 * what they decide and how they supersede each other. Records are ordinary Decision elements, so
 * they are created and edited with the element editor.
 */
export function Decisions() {
  const { ws } = useParams();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const searchId = useId();
  const statusId = useId();
  const vq = viewQuery(useView().view);
  const log = useQuery({ queryKey: ['decisions', ws, vq], queryFn: () => api.decisions(ws!, vq) });

  const all = log.data ?? [];
  const q = text.trim().toLowerCase();
  const list = all.filter(
    (d) => (!status || d.status === status) && (!q || d.name.toLowerCase().includes(q) || d.decides.some((x) => x.name.toLowerCase().includes(q))),
  );
  const selectedId = params.get('d') ?? list[0]?.id ?? null;
  const selected = all.find((d) => d.id === selectedId) ?? null;
  const select = (id: string) => setParams({ d: id }, { replace: true });
  // Keep the URL pointing at what is shown once the log loads.
  const first = list[0]?.id;
  useEffect(() => {
    if (!params.get('d') && first) setParams({ d: first }, { replace: true });
  }, [first, params, setParams]);

  return (
    <div className="decisions">
      <aside className="pane left">
        <div className="decisions-tools">
          <h2>Decisions</h2>
          <Link className="button small primary" to={`/w/${ws}/new?type=Decision`}>
            + New decision
          </Link>
        </div>
        <div className="field">
          <label htmlFor={searchId}>Search</label>
          <input id={searchId} type="search" placeholder="Title or decided element" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={statusId}>Status</label>
          <select id={statusId} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        {log.error && <ErrorBanner error={log.error} />}
        {log.data && list.length === 0 && <p className="muted small">No decisions match.</p>}
        <ul className="items" aria-label="Decision log">
          {list.map((d) => (
            <li key={d.id} className={d.id === selectedId ? 'selected' : ''}>
              <button className="item" onClick={() => select(d.id)}>
                <span className="name">
                  {d.findings.length > 0 && (
                    <span className="warn-dot" title={`${d.findings.length} finding(s)`} aria-label="has findings">
                      !
                    </span>
                  )}
                  {d.name}
                </span>
                <span className="muted small">
                  <StatusBadge status={d.status} /> {d.decidedOn ?? 'undated'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="pane main">
        <ViewBar workspaceId={ws!} />
        <ViewNotice workspaceId={ws!} />
        {!selected && log.data && (
          <div className="empty">
            <p>No decision selected.</p>
          </div>
        )}
        {selected && <DecisionDetail d={selected} workspaceId={ws!} onPick={select} />}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  return <span className={`badge dec-${(status ?? 'none').toLowerCase()}`}>{status ?? 'NO STATUS'}</span>;
}

function DecisionDetail({ d, workspaceId: ws, onPick }: { d: DecisionRecord; workspaceId: string; onPick(id: string): void }) {
  const el = (r: DecisionRef) => (
    <>
      <Link to={`/w/${ws}/e/${r.id}`}>{r.name}</Link> <span className="muted small">{r.type}</span>
      {r.lifecycle && <span className={`badge lc-${r.lifecycle.toLowerCase()}`}>{r.lifecycle}</span>}
    </>
  );
  const decision = (r: DecisionRef) => (
    <button className="link" onClick={() => onPick(r.id)}>
      {r.name}
    </button>
  );
  return (
    <article className="decision" aria-label="Decision record">
      <header>
        <h2>{d.name}</h2>
        <p className="muted">
          <StatusBadge status={d.status} /> {d.decidedOn ? `decided ${d.decidedOn}` : 'no decision date'} ·{' '}
          <Link to={`/w/${ws}/e/${d.id}`}>Open in Explorer</Link> · <Link to={`/w/${ws}/e/${d.id}/edit`}>Edit</Link>
        </p>
      </header>

      {d.findings.length > 0 && (
        <div className="card findings" role="note" aria-label="Findings">
          <ul className="plain">
            {d.findings.map((f) => (
              <li key={f}>⚠ {f}</li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h3>Context</h3>
        <p className="prose">{d.context ?? <span className="muted">Not recorded.</span>}</p>
      </section>

      <section>
        <h3>Options</h3>
        {d.options.length === 0 ? (
          <p className="muted small">No options recorded (CONSIDERED / CHOSE).</p>
        ) : (
          <ul className="plain options">
            {d.options.map((o) => (
              <li key={o.id} className={o.chosen ? 'chosen' : ''}>
                {o.chosen ? <span className="badge chosen">chosen</span> : <span className="badge muted">considered</span>} {el(o)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Consequences</h3>
        <p className="prose">{d.consequences ?? <span className="muted">Not recorded.</span>}</p>
      </section>

      <section>
        <h3>Decides</h3>
        {d.decides.length === 0 ? (
          <p className="muted small">Not linked to any element (DECIDES).</p>
        ) : (
          <ul className="plain">
            {d.decides.map((x) => (
              <li key={x.id}>{el(x)}</li>
            ))}
          </ul>
        )}
      </section>

      {(d.supersedes.length > 0 || d.supersededBy.length > 0) && (
        <section>
          <h3>History</h3>
          <ul className="plain">
            {d.supersedes.map((x) => (
              <li key={`s${x.id}`}>Supersedes {decision(x)}</li>
            ))}
            {d.supersededBy.map((x) => (
              <li key={`b${x.id}`}>Superseded by {decision(x)}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
