import { Link } from 'react-router-dom';
import type { RunResult } from '../api';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cell).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Nodes/relationships from the runner: show their name or type.
    const props = (o['properties'] as Record<string, unknown> | undefined) ?? o;
    return String(props['name'] ?? o['type'] ?? JSON.stringify(v));
  }
  return String(v);
}

export function toCsv(r: RunResult): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [r.columns.map(esc).join(','), ...r.rows.map((row) => r.columns.map((c) => esc(cell(row[c]))).join(','))].join('\n');
}

/** Tabular run result; element ids link to the explorer. */
export function ResultTable({ result, workspaceId, title }: { result: RunResult; workspaceId: string; title: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(result)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="results">
      <div className="card-head">
        <span className="muted small">
          {result.rows.length} row{result.rows.length === 1 ? '' : 's'} · v{result.version} · {result.durationMs} ms
          {result.truncated && ' · truncated at the row limit'}
          {result.status === 'deprecated' && ' · deprecated version'}
        </span>
        <button className="button small" onClick={download} disabled={!result.rows.length}>
          Download CSV
        </button>
      </div>
      {result.rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((c) => {
                    const v = row[c];
                    return (
                      <td key={c}>
                        {typeof v === 'string' && ULID.test(v) ? <Link to={`/w/${workspaceId}/e/${v}`}>open</Link> : cell(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No results.</p>
      )}
    </div>
  );
}
