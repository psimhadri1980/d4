import type { MetamodelRegistry } from '@d4/metamodel';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { useRegistry } from '@d4/web-platform';
import { type AnalyzedTable, importApi, type TabularImportResult, type TableMapping, type Upload } from '../modules/data/api';

const ELEMENT_FIELDS = ['name', 'type', 'key', 'id', 'externalKey', 'lifecycle', 'description', 'validFrom', 'validTo', 'scenarioId'];
const RELATIONSHIP_FIELDS = ['type', 'from', 'to', 'id', 'validFrom', 'validTo', 'scenarioId'];

const toBase64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * Spreadsheet import: choose CSV or Excel files, check the suggested mapping for each table,
 * dry-run to see what would change and which rows have problems, then import as one change.
 */
export function Import() {
  const { ws } = useParams();
  const registry = useRegistry(ws);
  const queryClient = useQueryClient();
  const fileId = useId();
  const [files, setFiles] = useState<Upload[]>([]);
  const [tables, setTables] = useState<AnalyzedTable[]>([]);
  const [mappings, setMappings] = useState<Record<string, TableMapping>>({});
  const [result, setResult] = useState<{ dryRun: boolean; r: TabularImportResult } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [background, setBackground] = useState(false);
  const [queued, setQueued] = useState(false);

  const step = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const choose = async (list: FileList | null) => {
    setResult(null);
    setTables([]);
    if (!list?.length) return setFiles([]);
    const uploads = await Promise.all([...list].map(async (f) => ({ name: f.name, content: await toBase64(f) })));
    setFiles(uploads);
    const analyzed = await step('Reading files…', () => importApi.analyze(ws!, uploads));
    if (analyzed) {
      setTables(analyzed.tables);
      setMappings(Object.fromEntries(analyzed.tables.map((t) => [t.name, t.mapping])));
    }
  };

  const run = async (dryRun: boolean) => {
    if (!dryRun && background) {
      const job = await step('Starting…', () => importApi.createJob(ws!, files, tables.map((t) => ({ table: t.name, mapping: mappings[t.name]! })), false));
      if (job) setQueued(true);
      return;
    }
    const r = await step(dryRun ? 'Checking…' : 'Importing…', () =>
      importApi.importTabular(ws!, files, tables.map((t) => ({ table: t.name, mapping: mappings[t.name]! })), dryRun),
    );
    if (r) {
      setResult({ dryRun, r });
      if (r.applied) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === ws });
    }
  };
  const setMapping = (table: string, m: TableMapping) => {
    setMappings((all) => ({ ...all, [table]: m }));
    setResult(null);
  };

  if (registry.error) return <ErrorBanner error={registry.error} />;
  if (!registry.data) return <div className="splash">Loading metamodel…</div>;
  const checked = result?.dryRun && result.r.ok;

  return (
    <div className="import-page">
      <header>
        <h2>Import from spreadsheets</h2>
        <p className="muted">
          CSV files or Excel workbooks (each sheet is a table). Element rows need a name and a type (a column, or one type for the
          whole sheet). Relationship rows need a type and the two ends, given as a key from this import or an existing element's id,
          external key or name (“Type: Name” when a name is not unique). Nothing is written until every row is valid.
        </p>
      </header>

      <div className="field">
        <label htmlFor={fileId}>Files (.csv, .xlsx)</label>
        <input id={fileId} type="file" multiple accept=".csv,.xlsx" onChange={(e) => void choose(e.target.files)} />
      </div>
      {busy && <p className="muted" role="status">{busy}</p>}
      {error != null && <ErrorBanner error={error} />}

      {tables.map((t) => (
        <TableCard key={t.name} table={t} mapping={mappings[t.name]!} registry={registry.data!} onChange={(m) => setMapping(t.name, m)} />
      ))}

      {tables.length > 0 && (
        <div className="import-actions">
          <button className="button" onClick={() => void run(true)} disabled={!!busy}>
            Check (dry run)
          </button>
          <button className="button primary" onClick={() => void run(false)} disabled={!!busy || !checked}>
            {background ? 'Import in background' : 'Import'}
          </button>
          <label className="inline check-inline">
            <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} /> In background (large files)
          </label>
          {!checked && <span className="muted small">Run a successful check first.</span>}
          {queued && (
            <span role="status">
              Started. <Link to={`/w/${ws}/jobs`}>See Jobs</Link>
            </span>
          )}
        </div>
      )}

      {result && <ResultView result={result.r} dryRun={result.dryRun} workspaceId={ws!} />}
    </div>
  );
}

function TableCard({ table: t, mapping: m, registry, onChange }: { table: AnalyzedTable; mapping: TableMapping; registry: MetamodelRegistry; onChange(m: TableMapping): void }) {
  const kindId = useId();
  const typeId = useId();
  const columns = m.kind === 'ignore' ? {} : m.columns;
  const types =
    m.kind === 'relationships'
      ? registry.relationshipTypes().map((r) => r.name)
      : registry
          .nodeTypes()
          .filter((n) => !n.internal)
          .map((n) => n.name)
          .sort();
  const attrs =
    m.kind === 'relationships'
      ? (m.type ? registry.relationshipType(m.type)?.attributes ?? [] : registry.relationshipTypes().flatMap((r) => r.attributes)).map((a) => a.name)
      : (m.kind === 'elements' && m.type ? registry.attributesFor(m.type) : registry.nodeTypes().flatMap((n) => registry.attributesFor(n.name))).map((a) => a.name);
  const fields = m.kind === 'relationships' ? RELATIONSHIP_FIELDS : ELEMENT_FIELDS;
  const attrOptions = [...new Set(attrs)].filter((a) => !fields.includes(a) && a !== 'name').sort();

  const setKind = (kind: TableMapping['kind']) =>
    onChange(kind === 'ignore' ? { kind } : { kind, columns: Object.fromEntries(t.headers.map((h) => [h, 'ignore'])) });

  return (
    <section className="card import-table" aria-label={`Table ${t.name}`}>
      <div className="card-head">
        <h3>
          {t.name} <span className="muted small">· {t.rowCount} rows</span>
        </h3>
      </div>
      <div className="import-table-head">
        <div className="field">
          <label htmlFor={kindId}>Rows are</label>
          <select id={kindId} value={m.kind} onChange={(e) => setKind(e.target.value as TableMapping['kind'])}>
            <option value="elements">Elements</option>
            <option value="relationships">Relationships</option>
            <option value="ignore">Skip this table</option>
          </select>
        </div>
        {m.kind !== 'ignore' && (
          <div className="field">
            <label htmlFor={typeId}>Type for every row</label>
            <select id={typeId} value={m.type ?? ''} onChange={(e) => onChange({ ...m, type: e.target.value || undefined })}>
              <option value="">— from a Type column —</option>
              {types.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      {m.kind !== 'ignore' && (
        <div className="matrix-scroll">
          <table className="mapping">
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Maps to</th>
                <th scope="col">Sample values</th>
              </tr>
            </thead>
            <tbody>
              {t.headers.map((h, i) => (
                <tr key={h}>
                  <th scope="row">{h}</th>
                  <td>
                    <select aria-label={`Map column ${h}`} value={columns[h] ?? 'ignore'} onChange={(e) => onChange({ ...m, columns: { ...columns, [h]: e.target.value } })}>
                      <option value="ignore">— ignore —</option>
                      {fields.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                      <optgroup label="Attributes">
                        {attrOptions.map((a) => (
                          <option key={a} value={`attr:${a}`}>
                            {a}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                  <td className="muted small">
                    {t.preview
                      .map((r) => r[i])
                      .filter(Boolean)
                      .slice(0, 3)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ResultView({ result: r, dryRun, workspaceId }: { result: TabularImportResult; dryRun: boolean; workspaceId: string }) {
  const counts = (c: TabularImportResult['elements']) => `${c.created} new · ${c.updated} changed · ${c.unchanged} unchanged`;
  return (
    <section className={`card import-result ${r.ok ? 'ok' : 'bad'}`} aria-label="Import result">
      <div className="card-head">
        <h3>{r.applied ? '✓ Imported' : dryRun ? (r.ok ? '✓ Ready to import' : '✗ Not ready') : r.ok ? '✓ Nothing to change' : '✗ Not imported'}</h3>
      </div>
      <p>
        Elements: {counts(r.elements)}
        <br />
        Relationships: {counts(r.relationships)}
      </p>
      {r.applied && (
        <p>
          <Link to={`/w/${workspaceId}`}>Open the Explorer</Link>
        </p>
      )}
      {r.rowIssues.length > 0 && (
        <>
          <h3>Rows to fix ({r.rowIssues.length})</h3>
          <table className="issues">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Row</th>
                <th scope="col">Column</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {r.rowIssues.slice(0, 200).map((i, n) => (
                <tr key={n}>
                  <td>{i.table}</td>
                  <td>{i.row}</td>
                  <td>{i.column ?? ''}</td>
                  <td>{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {r.issues.length > 0 && (
        <>
          <h3>Model rules ({r.issues.length})</h3>
          <ul className="plain">
            {r.issues.slice(0, 100).map((i, n) => (
              <li key={n}>
                {i.message}
                {i.ruleId && <span className="muted small"> · {i.ruleId}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
