import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { api, isBaselineToday, useView } from '@d4/web-platform';

/** Scenarios in a workspace, for pickers. */
export function useScenarios(workspaceId: string) {
  return useQuery({
    queryKey: ['elements', workspaceId, 'scenarios'],
    queryFn: () => api.listElements(workspaceId, { type: ['Scenario'], first: 200 }),
    select: (page) => page.items,
  });
}

/** "As of" date and scenario for the Explorer; applies to the list, graph and details. */
export function ViewBar({ workspaceId }: { workspaceId: string }) {
  const { view, setView } = useView();
  const scenarios = useScenarios(workspaceId);
  const dateId = useId();
  const scenarioId = useId();
  return (
    <div className="view-bar" role="group" aria-label="Model view">
      <label className="inline" htmlFor={dateId}>
        As of
      </label>
      <input id={dateId} type="date" value={view.asOf} onChange={(e) => setView({ ...view, asOf: e.target.value })} />
      <label className="inline" htmlFor={scenarioId}>
        Scenario
      </label>
      <select id={scenarioId} value={view.scenario} onChange={(e) => setView({ ...view, scenario: e.target.value })}>
        <option value="">— Baseline —</option>
        {scenarios.data?.map((s) => (
          <option key={s.id} value={s.id}>
            {String(s.attrs['name'] ?? s.id)}
          </option>
        ))}
      </select>
      {!isBaselineToday(view) && (
        <button className="button small ghost" onClick={() => setView({ asOf: '', scenario: '' })}>
          Reset
        </button>
      )}
    </div>
  );
}

/** One-line reminder of the active view, shown above the graph and in the details pane. */
export function ViewNotice({ workspaceId }: { workspaceId: string }) {
  const { view } = useView();
  const scenarios = useScenarios(workspaceId);
  if (isBaselineToday(view)) return null;
  const scenario = scenarios.data?.find((s) => s.id === view.scenario);
  const parts = [
    view.asOf ? `as of ${view.asOf}` : 'all dates',
    view.scenario ? `scenario “${String(scenario?.attrs['name'] ?? '…')}” on top of the baseline` : 'baseline',
  ];
  return (
    <p className="view-notice" role="status">
      Viewing the model {parts.join(', ')}.
    </p>
  );
}
