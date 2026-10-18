import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { catalogApi, type QueryVersion } from '../api';
import { ErrorBanner } from './ErrorBanner';
import { missingRequired, ParamForm, paramLabel, paramsFromForm, type ParamValues } from './ParamForm';
import { QueryResultView } from './QueryResultView';

/** Runs the saved draft (or version in review) with tight limits so authors and stewards can check it. */
export function TestRunPanel({ workspaceId, queryId, version, title }: { workspaceId: string; queryId: string; version: QueryVersion; title: string }) {
  const [values, setValues] = useState<ParamValues>({});
  const [missing, setMissing] = useState<string[]>([]);
  const run = useMutation({ mutationFn: () => catalogApi.test(workspaceId, queryId, paramsFromForm(version.params, values)) });

  return (
    <div className="card test-run">
      <h3>Test run v{version.version}</h3>
      <p className="muted small">Runs the last saved {version.status === 'in_review' ? 'submitted version' : 'draft'} against this workspace: at most 100 rows and 10 s, not logged.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const gaps = missingRequired(version.params, values).map(paramLabel);
          setMissing(gaps);
          if (!gaps.length) run.mutate();
        }}
      >
        <ParamForm workspaceId={workspaceId} defs={version.params} values={values} onChange={setValues} />
        <button className="button" type="submit" disabled={run.isPending}>
          {run.isPending ? 'Running…' : 'Test run'}
        </button>
      </form>
      {missing.length > 0 && (
        <div className="error-banner" role="alert">
          Please fill in: {missing.join(', ')}
        </div>
      )}
      <ErrorBanner error={run.error} />
      {run.data && <QueryResultView result={run.data} workspaceId={workspaceId} title={title} shape={version.resultShape} />}
    </div>
  );
}
