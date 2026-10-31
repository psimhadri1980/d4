import { useSyncExternalStore } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { moduleFor, modulesVersion, pendingModules, registryState, subscribeModules } from '../lifecycle';

/**
 * A path under the workspace that no built-in module claims: a lifecycle module's (rendered by
 * single-spa into the page slot), one still loading, one that failed, or none (back to the start).
 */
export function ModuleOutlet() {
  useSyncExternalStore(subscribeModules, modulesVersion);
  const segment = useParams()['*']?.split('/')[0] ?? '';
  const state = moduleFor(segment);
  const registry = registryState();
  const pending = pendingModules();
  // A deep link may belong to a module whose manifest (and so its paths) has not arrived yet.
  if (!state && (!registry.ready || pending.loading)) return <p className="muted" role="status">Loading…</p>;
  if (!state && !registry.failed && !pending.failed) return <Navigate to="/" replace />;
  if (state?.status === 'loading') return <p className="muted" role="status">Loading…</p>;
  if (!state || state.status === 'failed')
    return (
      <div className="error-banner" role="alert">
        <strong>This part of D4 is unavailable at the moment.</strong>
        <div>Try again later.</div>
      </div>
    );
  return null;
}
