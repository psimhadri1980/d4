import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { ErrorBanner } from './components/ErrorBanner';
import { Layout } from './components/Layout';
import { ElementEditor } from './pages/ElementEditor';
import { Explorer } from './pages/Explorer';
import { Queries, type TabMode } from './pages/Queries';
import { Roadmap } from './pages/Roadmap';

export function App() {
  const { user, ready, returnTo } = useAuth();
  if (!ready || !user) return <div className="splash">Signing in…</div>;

  return (
    <Routes>
      <Route path="/" element={<FirstWorkspace />} />
      <Route path="/callback" element={returnTo && returnTo !== '/' ? <Navigate to={returnTo} replace /> : <FirstWorkspace />} />
      <Route path="/w/:ws" element={<Layout />}>
        <Route index element={<Explorer />} />
        <Route path="e/:id" element={<Explorer />} />
        <Route path="new" element={<ElementEditor mode="create" />} />
        <Route path="e/:id/edit" element={<ElementEditor mode="edit" />} />
        <Route path="queries" element={<Queries />} />
        <Route path="roadmap" element={<Roadmap />} />
        {/* Earlier separate screens now open as tabs in Queries. */}
        <Route path="catalog/:qid?" element={<ToQueries mode="run" />} />
        <Route path="studio/:qid?" element={<ToQueries mode="edit" />} />
        <Route path="stewardship/:qid?" element={<ToQueries mode="review" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function FirstWorkspace() {
  const { data, error } = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <div className="splash">Loading workspaces…</div>;
  if (!data.length) return <div className="splash">No workspaces yet.</div>;
  return <Navigate to={`/w/${data[0]!.id}`} replace />;
}

function ToQueries({ mode }: { mode: TabMode }) {
  const { ws, qid } = useParams();
  return <Navigate to={`/w/${ws}/queries${qid ? `?tabs=${mode}:${qid}&active=${mode}:${qid}` : ''}`} replace />;
}
