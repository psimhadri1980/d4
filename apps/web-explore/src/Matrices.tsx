import { MATRIX_KINDS, matrixToCsv, type Matrix, type MatrixKind } from '@d4/core';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useView, viewQuery } from '@d4/web-platform';
import { exploreApi } from './api';
import { download, ErrorBanner, ViewBar, ViewNotice } from '@d4/ui-kit';

const LABEL: Record<MatrixKind, string> = {
  crud: 'CRUD-I',
  'capability-application': 'Capability × application',
  'data-store-roles': 'Data store roles',
  lifecycle: 'Lifecycle',
};

/** Short cell labels; the full value is in the tooltip and the legend. */
const SHORT: Record<string, string> = {
  CREATE: 'C',
  READ: 'R',
  UPDATE: 'U',
  INACTIVATE: 'I',
  DELETE: 'D',
  MASTER: 'M',
  GOLDEN_COPY: 'GC',
  APPROVED_DISTRIBUTOR: 'AD',
  REPLICA: 'R',
  CONSUMER_CACHE: 'CC',
  INVEST: 'I',
  TOLERATE: 'T',
  MIGRATE: 'M',
  ELIMINATE: 'E',
  REALIZES: '✓',
};

/**
 * Matrices with findings: CRUD-I, capability × application, data store roles and a lifecycle
 * heat-map. They follow the Explorer's model view (as of / scenario).
 */
export function Matrices() {
  const { ws } = useParams();
  const [params, setParams] = useSearchParams();
  const raw = params.get('kind') as MatrixKind | null;
  const kind: MatrixKind = raw && MATRIX_KINDS.includes(raw) ? raw : 'crud';
  const { view } = useView();
  const vq = viewQuery(view);
  const matrix = useQuery({ queryKey: ['matrix', ws, kind, vq], queryFn: () => exploreApi.matrix(ws!, kind, vq) });
  const m = matrix.data;

  return (
    <div className="matrices-page">
      <header className="matrices-head">
        <h2>Matrices</h2>
        <div className="segmented" role="group" aria-label="Matrix">
          {MATRIX_KINDS.map((k) => (
            <button key={k} className={k === kind ? 'active' : ''} aria-pressed={k === kind} onClick={() => setParams(k === 'crud' ? {} : { kind: k }, { replace: true })}>
              {LABEL[k]}
            </button>
          ))}
        </div>
        <ViewBar workspaceId={ws!} />
      </header>
      <ViewNotice workspaceId={ws!} />
      {matrix.error && <ErrorBanner error={matrix.error} />}
      {!m && !matrix.error && <p className="muted">Loading…</p>}
      {m && <MatrixView matrix={m} workspaceId={ws!} />}
    </div>
  );
}

function MatrixView({ matrix: m, workspaceId }: { matrix: Matrix & { truncated: boolean }; workspaceId: string }) {
  const cells = useMemo(() => new Map(m.cells.map((c) => [`${c.row}\u0000${c.column}`, c.values])), [m]);
  const heat = m.kind === 'lifecycle';
  const max = heat ? Math.max(1, ...m.cells.map((c) => Number(c.values[0]))) : 1;
  const link = (id: string, name: string, type: string) =>
    type === 'Lifecycle' || m.kind === 'lifecycle' ? name : <Link to={`/w/${workspaceId}/e/${id}`}>{name}</Link>;
  const groups = [...new Set(m.rows.map((r) => r.group ?? ''))];

  return (
    <>
      <div className="matrix-head">
        <p className="muted small">
          {m.rows.length} {m.rowLabel.toLowerCase()}s × {m.columns.length} {m.columnLabel.toLowerCase()}s
          {m.truncated && ' · truncated'}
        </p>
        {m.values.length > 0 && (
          <ul className="matrix-legend" aria-label="Legend">
            {m.values.map((v) => (
              <li key={v}>
                <span className={`mcell v-${v.toLowerCase()}`}>{SHORT[v] ?? v}</span> {v.replace(/_/g, ' ').toLowerCase()}
              </li>
            ))}
          </ul>
        )}
        <button className="button small" onClick={() => download(`${m.kind}.csv`, matrixToCsv(m), 'text/csv')} disabled={!m.rows.length}>
          Export CSV
        </button>
      </div>

      {m.rows.length === 0 ? (
        <div className="empty">
          <p>Nothing to show in this view.</p>
        </div>
      ) : (
        <div className="matrix-scroll">
          <table className={`matrix ${heat ? 'heat' : ''}`} aria-label={m.title}>
            <thead>
              <tr>
                <th scope="col" className="corner">
                  {m.rowLabel} ↓ · {m.columnLabel} →
                </th>
                {m.columns.map((c) => (
                  <th key={c.id} scope="col" className="col-head">
                    <span>{link(c.id, c.name, c.type)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g}>
                  {g && (
                    <tr className="group-row">
                      <th scope="rowgroup" colSpan={m.columns.length + 1}>
                        {g}
                      </th>
                    </tr>
                  )}
                  {m.rows
                    .filter((r) => (r.group ?? '') === g)
                    .map((r) => (
                      <tr key={r.id}>
                        <th scope="row" className="row-head">
                          {link(r.id, r.name, r.type)}
                        </th>
                        {m.columns.map((c) => {
                          const v = cells.get(`${r.id}\u0000${c.id}`);
                          if (heat) {
                            const n = v ? Number(v[0]) : 0;
                            return (
                              <td key={c.id} className={`heat-cell ${n / max > 0.5 ? 'hot' : ''}`} style={n ? { ['--heat' as string]: String(0.15 + 0.85 * (n / max)) } : undefined} title={`${r.name} · ${c.name}: ${n}`}>
                                {n || ''}
                              </td>
                            );
                          }
                          return (
                            <td key={c.id} title={v ? `${r.name} · ${c.name}: ${v.join(', ')}` : undefined}>
                              {v?.map((x) => (
                                <span key={x} className={`mcell v-${x.toLowerCase()}`}>
                                  {SHORT[x] ?? x}
                                </span>
                              ))}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="card" aria-label="Findings">
        <div className="card-head">
          <h3>Findings</h3>
        </div>
        {m.findings.length === 0 ? (
          <p className="muted small">✓ Nothing to flag.</p>
        ) : (
          <ul className="plain">
            {m.findings.map((f) => (
              <li key={f}>⚠ {f}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
