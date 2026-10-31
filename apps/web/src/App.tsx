import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ModuleOutlet } from './components/ModuleOutlet';
import { api, keys, useAuth } from '@d4/web-platform';
import { ErrorBanner } from '@d4/ui-kit';

export function App() {
  const { user, ready, returnTo } = useAuth();
  if (!ready || !user) return <div className="splash">Signing in…</div>;

  return (
    <Routes>
      <Route path="/" element={<FirstWorkspace />} />
      <Route path="/callback" element={returnTo && returnTo !== '/' ? <Navigate to={returnTo} replace /> : <FirstWorkspace />} />
      <Route path="/w/:ws" element={<Layout />}>
        {/* Every page under the workspace, its home included, belongs to a lifecycle module. */}
        <Route index element={<ModuleOutlet />} />
        <Route path="*" element={<ModuleOutlet />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function FirstWorkspace() {
  const { data, error } = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <div className="splash">Loading workspaces…</div>;
  if (!data.length) return <div className="splash">No workspaces yet.</div>;
  return <Navigate to={`/w/${data[0]!.id}`} replace />;
}
