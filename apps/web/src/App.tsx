import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { ErrorBanner } from './components/ErrorBanner';
import { Layout } from './components/Layout';
import { Catalog } from './pages/Catalog';
import { ElementEditor } from './pages/ElementEditor';
import { Explorer } from './pages/Explorer';
import { QueryStudio } from './pages/QueryStudio';
import { Stewardship } from './pages/Stewardship';

export function App() {
  const { user, ready } = useAuth();
  if (!ready || !user) return <div className="splash">Signing in…</div>;

  return (
    <Routes>
      <Route path="/" element={<FirstWorkspace />} />
      <Route path="/callback" element={<FirstWorkspace />} />
      <Route path="/w/:ws" element={<Layout />}>
        <Route index element={<Explorer />} />
        <Route path="e/:id" element={<Explorer />} />
        <Route path="new" element={<ElementEditor mode="create" />} />
        <Route path="e/:id/edit" element={<ElementEditor mode="edit" />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="catalog/:qid" element={<Catalog />} />
        <Route path="studio" element={<QueryStudio />} />
        <Route path="studio/:qid" element={<QueryStudio />} />
        <Route path="stewardship" element={<Stewardship />} />
        <Route path="stewardship/:qid" element={<Stewardship />} />
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
