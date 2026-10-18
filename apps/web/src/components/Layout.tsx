import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, can } from '../api';
import { useAuth } from '../auth';

export function Layout() {
  const { ws } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  return (
    <div className="app">
      <header className="topbar">
        <Link to={`/w/${ws}`} className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          D4
        </Link>
        <label className="ws-picker">
          <span className="muted">Workspace</span>
          <select value={ws} onChange={(e) => navigate(`/w/${e.target.value}`)}>
            {workspaces.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav className="nav" aria-label="Main">
          <NavLink to={`/w/${ws}`} end>
            Explorer
          </NavLink>
          <NavLink to={`/w/${ws}/catalog`}>Catalog</NavLink>
          {can(me.data?.roles).author && <NavLink to={`/w/${ws}/studio`}>Studio</NavLink>}
          {can(me.data?.roles).steward && <NavLink to={`/w/${ws}/stewardship`}>Stewardship</NavLink>}
        </nav>
        <div className="spacer" />
        <Link to={`/w/${ws}/new`} className="button primary">
          + New element
        </Link>
        <div className="user">
          <span>{(user?.profile.preferred_username as string | undefined) ?? user?.profile.email}</span>
          <span className="muted small">{me.data?.roles.join(', ')}</span>
        </div>
        <button className="button ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
