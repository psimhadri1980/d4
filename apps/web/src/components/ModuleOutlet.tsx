import { useSyncExternalStore } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { moduleStates, modulesVersion, subscribeModules } from '../lifecycle';

/**
 * A path under the workspace that no built-in module claims: a lifecycle module's (rendered by
 * single-spa into the page slot), one still loading, one that failed, or none (back to the start).
 */
export function ModuleOutlet() {
  useSyncExternalStore(subscribeModules, modulesVersion);
  const name = useParams()['*']?.split('/')[0] ?? '';
  const state = moduleStates().get(name);
  if (!state) return <Navigate to="/" replace />;
  if (state.status === 'loading') return <p className="muted" role="status">Loading…</p>;
  if (state.status === 'failed')
    return (
      <div className="error-banner" role="alert">
        <strong>This part of D4 is unavailable at the moment.</strong>
        <div>Try again later.</div>
      </div>
    );
  return null;
}
