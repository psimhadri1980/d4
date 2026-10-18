import { useQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type Element, type Relationship, type ViewParams } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { useScenarios } from '../components/ViewBar';

const today = () => new Date().toISOString().slice(0, 10);
const inAYear = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v));

/**
 * Compares two views of the model, e.g. today vs. a year ahead, or the baseline vs. a scenario on
 * the same date. Both sides live in the URL so a comparison can be shared.
 */
export function Compare() {
  const { ws } = useParams();
  const [params, setParams] = useSearchParams();
  const side = (k: 'from' | 'to', fallbackDate: string): ViewParams => ({
    asOf: params.get(`${k}AsOf`) ?? fallbackDate,
    scenario: params.get(`${k}Scenario`) ?? '',
  });
  const from = side('from', today());
  const to = side('to', inAYear());
  const same = from.asOf === to.asOf && from.scenario === to.scenario;

  const set = (k: 'from' | 'to', v: ViewParams) => {
    const p = new URLSearchParams(params);
    p.set(`${k}AsOf`, v.asOf ?? '');
    if (v.scenario) p.set(`${k}Scenario`, v.scenario);
    else p.delete(`${k}Scenario`);
    setParams(p, { replace: true });
  };
  const swap = () => {
    const p = new URLSearchParams();
    p.set('fromAsOf', to.asOf ?? '');
    if (to.scenario) p.set('fromScenario', to.scenario);
    p.set('toAsOf', from.asOf ?? '');
    if (from.scenario) p.set('toScenario', from.scenario);
    setParams(p, { replace: true });
  };

  const clean = (v: ViewParams): ViewParams => ({ asOf: v.asOf || undefined, scenario: v.scenario || undefined });
  const diff = useQuery({
    queryKey: ['diff', ws, from, to],
    enabled: !!ws && !same,
    queryFn: () => api.diff(ws!, clean(from), clean(to)),
  });
  const d = diff.data;
  const name = (id: string) => d?.names[id] ?? id;
  const el = (e: Element) => (
    <Link to={`/w/${ws}/e/${e.id}`}>{String(e.attrs['name'] ?? e.id)}</Link>
  );
  const rel = (r: Relationship) => (
    <>
      <Link to={`/w/${ws}/e/${r.fromId}`}>{name(r.fromId)}</Link> <span className="rel-type">{r.type}</span>{' '}
      <Link to={`/w/${ws}/e/${r.toId}`}>{name(r.toId)}</Link>
    </>
  );
  const attrs = (r: Relationship) =>
    Object.keys(r.attrs).length ? <span className="muted small"> · {Object.entries(r.attrs).map(([k, v]) => `${k}=${show(v)}`).join(', ')}</span> : null;
  const total = d
    ? d.elements.added.length + d.elements.removed.length + d.relationships.added.length + d.relationships.removed.length + d.relationships.changed.length
    : 0;

  return (
    <div className="compare-page">
      <header className="compare-head">
        <h2>Compare</h2>
        <div className="compare-sides">
          <SidePicker label="From" workspaceId={ws!} value={from} onChange={(v) => set('from', v)} />
          <button className="button small ghost" onClick={swap} aria-label="Swap from and to">
            ⇄
          </button>
          <SidePicker label="To" workspaceId={ws!} value={to} onChange={(v) => set('to', v)} />
        </div>
      </header>

      {same && <p className="muted">Pick two different dates, or a scenario on one side.</p>}
      {diff.error && <ErrorBanner error={diff.error} />}
      {!same && !d && !diff.error && <p className="muted">Comparing…</p>}
      {d && (
        <>
          <p className="compare-summary" aria-label="Comparison summary">
            {total === 0 ? (
              'No differences.'
            ) : (
              <>
                <span className="add">+{d.elements.added.length} elements</span>
                <span className="del">−{d.elements.removed.length} elements</span>
                <span className="add">+{d.relationships.added.length} relationships</span>
                <span className="del">−{d.relationships.removed.length} relationships</span>
                <span className="chg">~{d.relationships.changed.length} changed</span>
              </>
            )}
          </p>

          <div className="compare-grid">
            <DiffSection title="Elements added" kind="add" items={d.elements.added} render={(e) => <>{el(e)} <span className="muted small">{e.type}</span></>} />
            <DiffSection title="Elements removed" kind="del" items={d.elements.removed} render={(e) => <>{el(e)} <span className="muted small">{e.type}</span></>} />
            <DiffSection
              title="Relationships changed"
              kind="chg"
              items={d.relationships.changed}
              render={(c) => (
                <>
                  {rel(c.after)}
                  <ul className="field-changes">
                    {c.fields.map((f) => (
                      <li key={f.field}>
                        <span className="muted">{f.field}</span> <del>{show(f.before)}</del> → <ins>{show(f.after)}</ins>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            />
            <DiffSection title="Relationships added" kind="add" items={d.relationships.added} render={(r) => <>{rel(r)}{attrs(r)}</>} />
            <DiffSection title="Relationships removed" kind="del" items={d.relationships.removed} render={(r) => <>{rel(r)}{attrs(r)}</>} />
          </div>
        </>
      )}
    </div>
  );
}

function SidePicker({ label, workspaceId, value, onChange }: { label: string; workspaceId: string; value: ViewParams; onChange(v: ViewParams): void }) {
  const scenarios = useScenarios(workspaceId);
  const dateId = useId();
  const scenarioId = useId();
  return (
    <fieldset className="compare-side">
      <legend>{label}</legend>
      <div className="field">
        <label htmlFor={dateId}>{label} date</label>
        <input id={dateId} type="date" value={value.asOf ?? ''} onChange={(e) => onChange({ ...value, asOf: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={scenarioId}>{label} scenario</label>
        <select id={scenarioId} value={value.scenario ?? ''} onChange={(e) => onChange({ ...value, scenario: e.target.value })}>
          <option value="">— Baseline —</option>
          {scenarios.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {String(s.attrs['name'] ?? s.id)}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

function DiffSection<T>({
  title,
  kind,
  items,
  render,
}: {
  title: string;
  kind: 'add' | 'del' | 'chg';
  items: T[];
  render(item: T): ReactNode;
}) {
  return (
    <section className={`card diff-section ${kind}`} aria-label={title}>
      <div className="card-head">
        <h3>
          {title} <span className="count">{items.length}</span>
        </h3>
      </div>
      {items.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ul className="plain">
          {items.map((it, n) => (
            <li key={n}>{render(it)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
