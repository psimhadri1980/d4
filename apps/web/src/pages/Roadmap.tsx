import { LANE_KINDS, type LaneKind, type RoadmapConflict } from '@d4/core';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type Element } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Gantt, type GanttZoom } from '../components/Gantt';
import { download, roadmapToCsv, roadmapToMermaid } from '../roadmap-export';

const LANE_LABEL: Record<LaneKind, string> = {
  initiative: 'Initiative',
  division: 'Division',
  status: 'Status',
  type: 'Type',
  milestone: 'Milestone',
  none: 'No lanes',
};
const CONFLICT_LABEL: Record<string, string> = {
  cycle: 'Dependency cycle',
  unscheduled: 'Missing dates',
  'dependency-violated': 'Planned too early',
  'misses-milestone': 'Misses milestone',
  'change-after-retirement': 'Changes after retirement',
  'duplicate-introduction': 'Introduced twice',
  'past-due': 'Past due',
  'done-before-predecessor': 'Done before predecessor',
};
const ZOOMS: GanttZoom[] = ['week', 'month', 'quarter'];
const today = () => new Date().toISOString().slice(0, 10);
const nameOf = (e: Element | undefined) => (e ? String(e.attrs['name'] ?? e.id) : '');

/**
 * Roadmap Studio: pick a scope (initiatives, divisions or any element that deliverables change),
 * see the scheduled plan as a Gantt with lanes, dependencies and the critical path, review
 * conflicts, inspect an item and export. Scope, lanes and zoom live in the URL.
 */
export function Roadmap() {
  const { ws } = useParams();
  const [params, setParams] = useSearchParams();
  const scope = useMemo(() => (params.get('scope') ?? '').split(',').filter(Boolean), [params]);
  const lanesParam = params.get('lanes') as LaneKind | null;
  const lanes: LaneKind = lanesParam && LANE_KINDS.includes(lanesParam) ? lanesParam : 'initiative';
  const zoomParam = params.get('zoom') as GanttZoom | null;
  const zoom: GanttZoom = zoomParam && ZOOMS.includes(zoomParam) ? zoomParam : 'month';
  const [selected, setSelected] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const lanesId = useId();

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const setScope = (ids: string[]) => set('scope', ids.length ? [...new Set(ids)].join(',') : null);

  const roadmap = useQuery({
    queryKey: ['roadmap', ws, scope, lanes],
    enabled: !!ws && scope.length > 0,
    queryFn: () => api.roadmap(ws!, scope, lanes),
  });
  const r = roadmap.data;
  useEffect(() => setSelected(null), [scope.join(',')]);

  const item = r?.items.find((i) => i.id === selected);
  const names = new Map(r?.items.map((i) => [i.id, i.name]));

  return (
    <div className="roadmap">
      <aside className="pane left">
        <ScopePicker workspaceId={ws!} scope={scope} onChange={setScope} />

        <div className="field">
          <label htmlFor={lanesId}>Lanes by</label>
          <select id={lanesId} value={lanes} onChange={(e) => set('lanes', e.target.value === 'initiative' ? null : e.target.value)}>
            {LANE_KINDS.map((k) => (
              <option key={k} value={k}>
                {LANE_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <span className="label">Zoom</span>
          <div className="segmented" role="group" aria-label="Zoom">
            {ZOOMS.map((z) => (
              <button key={z} className={z === zoom ? 'active' : ''} aria-pressed={z === zoom} onClick={() => set('zoom', z === 'month' ? null : z)}>
                {z[0]!.toUpperCase() + z.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="roadmap-legend small muted">
          <span>
            <i className="swatch bar" /> Scheduled
          </span>
          <span>
            <i className="swatch planned" /> Planned (differs)
          </span>
          <span>
            <i className="swatch critical" /> Critical path
          </span>
          <span>
            <i className="swatch milestone" /> Milestone
          </span>
        </div>
      </aside>

      <section className="pane main">
        {!scope.length && (
          <div className="empty">
            <p>Choose an initiative, a division or any element on the left to see the deliverables that change it, scheduled with their dependencies.</p>
          </div>
        )}
        {roadmap.error && <ErrorBanner error={roadmap.error} />}
        {scope.length > 0 && !r && !roadmap.error && <p className="muted">Scheduling…</p>}
        {r && !r.items.length && (
          <div className="empty">
            <p>No deliverables or milestones in this scope.</p>
          </div>
        )}
        {r && r.items.length > 0 && (
          <>
            <div className="roadmap-head">
              <div className="summary" aria-label="Roadmap summary">
                <span>
                  <strong>{r.start}</strong> → <strong>{r.end}</strong>
                </span>
                <span>{r.items.length} items</span>
                <span>{r.criticalPath.length} on the critical path</span>
                <span className={r.conflicts.length ? 'warn' : ''}>
                  {r.conflicts.length} conflict{r.conflicts.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="actions">
                <button className="button small" onClick={() => download('roadmap.csv', roadmapToCsv(r), 'text/csv')}>
                  Export CSV
                </button>
                <button className="button small" onClick={() => download('roadmap.mmd', roadmapToMermaid(r), 'text/plain')}>
                  Export Mermaid
                </button>
              </div>
            </div>

            <Gantt roadmap={r} zoom={zoom} selected={selected} highlight={highlight} onSelect={setSelected} today={today()} />

            <section className="card conflicts" aria-label="Conflicts">
              <div className="card-head">
                <h3>Conflicts</h3>
              </div>
              {r.conflicts.length === 0 ? (
                <p className="muted small">✓ No conflicts. The plan is consistent with its dependencies.</p>
              ) : (
                <ul className="conflict-list">
                  {r.conflicts.map((c, n) => (
                    <ConflictRow
                      key={n}
                      c={c}
                      onPick={() => {
                        setSelected(c.itemIds[0] ?? null);
                        setHighlight(c.itemIds);
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </section>

      <aside className="pane right">
        {!item && <p className="muted small">Select a bar to see its schedule, slack and the elements it changes.</p>}
        {item && r && (
          <div className="roadmap-item" aria-label="Selected item">
            <h2>{item.name}</h2>
            <p className="muted small">
              {item.kind === 'milestone' ? 'Milestone' : 'Deliverable'}
              {item.lane ? ` · ${item.lane}` : ''}
              {item.status ? ` · ${item.status}` : ''}
            </p>
            <dl className="facts">
              <dt>Planned</dt>
              <dd>{item.kind === 'milestone' ? item.start ?? '—' : `${item.start ?? '—'} → ${item.end ?? '—'}`}</dd>
              <dt>Earliest</dt>
              <dd>{item.kind === 'milestone' ? item.earliestStart : `${item.earliestStart} → ${item.earliestEnd}`}</dd>
              {item.kind === 'deliverable' && (
                <>
                  <dt>Duration</dt>
                  <dd>{item.durationDays} days</dd>
                </>
              )}
              <dt>Slack</dt>
              <dd>{item.critical ? <span className="badge critical">critical</span> : `${item.slackDays} days`}</dd>
            </dl>

            <h3>Depends on</h3>
            <ItemList ids={r.dependencies.filter((d) => d.from === item.id).map((d) => d.to)} names={names} onPick={setSelected} empty="Nothing." />
            <h3>Needed by</h3>
            <ItemList ids={r.dependencies.filter((d) => d.to === item.id).map((d) => d.from)} names={names} onPick={setSelected} empty="Nothing." />

            {item.kind === 'deliverable' && (
              <>
                <h3>Changes</h3>
                {r.changes.filter((c) => c.deliverableId === item.id).length === 0 ? (
                  <p className="muted small">No CHANGES relationships.</p>
                ) : (
                  <ul className="plain">
                    {r.changes
                      .filter((c) => c.deliverableId === item.id)
                      .map((c) => (
                        <li key={c.elementId}>
                          <span className={`badge action-${c.action.toLowerCase()}`}>{c.action}</span>{' '}
                          <Link to={`/w/${ws}/e/${c.elementId}`}>{c.elementName}</Link> <span className="muted small">{c.elementType}</span>
                          {c.targetLifecycle && <span className="muted small"> → {c.targetLifecycle}</span>}
                        </li>
                      ))}
                  </ul>
                )}
              </>
            )}

            {r.conflicts.some((c) => c.itemIds.includes(item.id)) && (
              <>
                <h3>Conflicts</h3>
                <ul className="plain">
                  {r.conflicts
                    .filter((c) => c.itemIds.includes(item.id))
                    .map((c, n) => (
                      <li key={n} className="small">
                        {c.message}
                      </li>
                    ))}
                </ul>
              </>
            )}

            <p>
              <Link to={`/w/${ws}/e/${item.id}`}>Open in Explorer</Link> · <Link to={`/w/${ws}/e/${item.id}/edit`}>Edit dates</Link>
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function ConflictRow({ c, onPick }: { c: RoadmapConflict; onPick(): void }) {
  return (
    <li>
      <button className="item" onClick={onPick}>
        <span className={`badge conflict-${c.kind}`}>{CONFLICT_LABEL[c.kind] ?? c.kind}</span>
        <span>{c.message}</span>
      </button>
    </li>
  );
}

function ItemList({ ids, names, onPick, empty }: { ids: string[]; names: Map<string, string>; onPick(id: string): void; empty: string }) {
  if (!ids.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="plain">
      {ids.map((id) => (
        <li key={id}>
          <button className="link" onClick={() => onPick(id)}>
            {names.get(id) ?? id}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Quick picks for initiatives and divisions, a search for any element, and the chosen scope. */
function ScopePicker({ workspaceId, scope, onChange }: { workspaceId: string; scope: string[]; onChange(ids: string[]): void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const searchId = useId();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const initiatives = useQuery({
    queryKey: ['elements', workspaceId, 'Initiative'],
    queryFn: () => api.listElements(workspaceId, { type: ['Initiative', 'Program', 'Portfolio'], first: 100 }),
  });
  const divisions = useQuery({
    queryKey: ['elements', workspaceId, 'Division'],
    queryFn: () => api.listElements(workspaceId, { type: ['Division'], first: 100 }),
  });
  const found = useQuery({
    queryKey: ['elements', workspaceId, 'search', q],
    enabled: q.length > 1,
    queryFn: () => api.listElements(workspaceId, { q, first: 10 }),
  });
  const known = new Map<string, Element>(
    [...(initiatives.data?.items ?? []), ...(divisions.data?.items ?? []), ...(found.data?.items ?? [])].map((e) => [e.id, e]),
  );
  const unknown = scope.filter((id) => !known.has(id));
  const extra = useQueries({
    queries: unknown.map((id) => ({ queryKey: ['element', workspaceId, id], queryFn: () => api.element(workspaceId, id) })),
  });
  for (const e of extra) if (e.data) known.set(e.data.id, e.data);

  const toggle = (id: string) => onChange(scope.includes(id) ? scope.filter((x) => x !== id) : [...scope, id]);
  const pick = (list: Element[], title: string) => (
    <fieldset className="scope-group">
      <legend>{title}</legend>
      {list.length === 0 && <p className="muted small">None in this workspace.</p>}
      {list.map((e) => (
        <label key={e.id} className="scope-check">
          <input type="checkbox" checked={scope.includes(e.id)} onChange={() => toggle(e.id)} />
          {nameOf(e)}
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="scope-picker">
      <h2>Scope</h2>
      {scope.length > 0 && (
        <ul className="chips" aria-label="Selected scope">
          {scope.map((id) => (
            <li key={id} className="chip">
              {nameOf(known.get(id)) || '…'}
              <button aria-label={`Remove ${nameOf(known.get(id))} from scope`} onClick={() => toggle(id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {pick(initiatives.data?.items ?? [], 'Initiatives')}
      {pick(divisions.data?.items ?? [], 'Divisions')}
      <div className="field">
        <label htmlFor={searchId}>Any element</label>
        <input id={searchId} type="search" placeholder="Search, e.g. Legacy Client" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {q.length > 1 && (
        <ul className="items" aria-label="Search results">
          {(found.data?.items ?? []).map((e) => (
            <li key={e.id} className={scope.includes(e.id) ? 'selected' : ''}>
              <button className="item" onClick={() => toggle(e.id)}>
                <span className="name">{nameOf(e)}</span>
                <span className="muted small">{e.type}</span>
              </button>
            </li>
          ))}
          {found.data && !found.data.items.length && <li className="muted small">No matches.</li>}
        </ul>
      )}
    </div>
  );
}
