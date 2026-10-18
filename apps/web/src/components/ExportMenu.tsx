import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBanner } from './ErrorBanner';
import { viewQuery, type ViewState } from '../view';

const FORMATS: { value: string; label: string }[] = [
  { value: 'mermaid', label: 'Mermaid diagram (.mmd)' },
  { value: 'archimate', label: 'ArchiMate Open Exchange (.xml)' },
  { value: 'elements-csv', label: 'Elements (CSV)' },
  { value: 'relationships-csv', label: 'Relationships (CSV)' },
  { value: 'xlsx', label: 'Excel workbook (elements + relationships)' },
  { value: 'yaml', label: 'Model as code (YAML)' },
  { value: 'cypher', label: 'Cypher script' },
];
/** Pictures of the graph on screen, rendered in the background. */
const PICTURES = ['pdf', 'png', 'svg'];

/**
 * Exports what is on screen (the selected element's neighbourhood at the current depth) or the
 * whole workspace, in the current model view.
 */
export function ExportMenu({ workspaceId, elementId, depth, view }: { workspaceId: string; elementId?: string; depth: number; view: ViewState }) {
  const [format, setFormat] = useState('');
  const [what, setWhat] = useState<'view' | 'workspace'>(elementId ? 'view' : 'workspace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [background, setBackground] = useState(false);
  const [queued, setQueued] = useState(false);
  const formatId = useId();
  const whatId = useId();
  const scoped = what === 'view' && !!elementId;

  const run = async () => {
    setBusy(true);
    setError(null);
    setQueued(false);
    try {
      if (format.startsWith('picture:')) {
        await api.createRenderJob(workspaceId, { target: 'graph', format: format.slice(8), root: elementId, depth, ...viewQuery(view) });
        setQueued(true);
        return;
      }
      if (background) {
        await api.createExportJob(workspaceId, { format, ...viewQuery(view), ...(scoped && { scope: [elementId!], depth }) });
        setQueued(true);
        return;
      }
      const { blob, filename } = await api.exportFile(workspaceId, format, {
        ...viewQuery(view),
        ...(scoped && { scope: [elementId!], depth }),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-menu" role="group" aria-label="Export">
      <label className="inline" htmlFor={formatId}>
        Export
      </label>
      <select id={formatId} value={format} onChange={(e) => setFormat(e.target.value)}>
        <option value="">— choose a format —</option>
        <optgroup label="Data">
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Picture of this graph (background)">
          {PICTURES.map((f) => (
            <option key={f} value={`picture:${f}`} disabled={!elementId}>
              {f.toUpperCase()}
            </option>
          ))}
        </optgroup>
      </select>
      <label className="sr-only" htmlFor={whatId}>
        What to export
      </label>
      <select id={whatId} value={scoped ? 'view' : 'workspace'} onChange={(e) => setWhat(e.target.value as 'view' | 'workspace')}>
        <option value="view" disabled={!elementId}>
          This graph
        </option>
        <option value="workspace">Whole workspace</option>
      </select>
      <label className="inline check-inline">
        <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} /> In background
      </label>
      <button className="button small" onClick={() => void run()} disabled={!format || busy}>
        {busy ? 'Exporting…' : background || format.startsWith('picture:') ? 'Start' : 'Download'}
      </button>
      {queued && (
        <span className="small" role="status">
          Started. <Link to={`/w/${workspaceId}/jobs`}>See Jobs</Link>
        </span>
      )}
      {error != null && <ErrorBanner error={error} />}
    </div>
  );
}
