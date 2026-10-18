import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { applyTheme, storedTheme, type ThemeChoice } from '../theme';

export function Layout() {
  const { ws } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  // Explorer covers the workspace home, element pages and the element editor.
  const path = useLocation().pathname;
  const inExplorer = !path.startsWith(`/w/${ws}/queries`) && !path.startsWith(`/w/${ws}/roadmap`);

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
          {/* Plain Link: NavLink's prefix match would mark Explorer current on every page. */}
          <Link to={`/w/${ws}`} className={inExplorer ? 'active' : ''} aria-current={inExplorer ? 'page' : undefined}>
            Explorer
          </Link>
          <NavLink to={`/w/${ws}/queries`}>Queries</NavLink>
          <NavLink to={`/w/${ws}/roadmap`}>Roadmap</NavLink>
        </nav>
        <div className="spacer" />
        <Link to={`/w/${ws}/new`} className="button primary">
          + New element
        </Link>
        <div className="user">
          <span>{(user?.profile.preferred_username as string | undefined) ?? user?.profile.email}</span>
          <span className="muted small">{me.data?.roles.join(', ')}</span>
        </div>
        <label className="theme-picker">
          <span className="sr-only">Theme</span>
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => {
              const t = e.target.value as ThemeChoice;
              setTheme(t);
              applyTheme(t);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
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
