import { IconMenu2, IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { modulesVersion, startModules, subscribeModules } from '../lifecycle';
import { activeItem, subActive, visibleNav } from '../nav';
import { applyTheme, storedTheme, type ThemeChoice } from '../theme';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';
import { accessOf, api, keys, useAuth, useMe, ViewProvider } from '@d4/web-platform';

const COLLAPSED_KEY = 'd4-nav-collapsed';

function storedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== 'false'; // the icon rail is the default
  } catch {
    return true;
  }
}

/** The app shell: left navigation, a slim header (breadcrumb, search, user) and the page. */
export function Layout() {
  const { ws } = useParams();
  const location = useLocation();
  const { user, logout } = useAuth();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });
  const me = useMe();
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [searching, setSearching] = useState(false);

  const modules = useSyncExternalStore(subscribeModules, modulesVersion);
  const roles = me.data?.roles;
  // `modules` changes when a lifecycle module's menu arrives.
  const groups = useMemo(() => visibleNav({ ...accessOf(roles), admin: !!roles?.includes('admin') }), [roles, modules]);
  const rest = location.pathname.replace(new RegExp(`^/w/${ws}/?`), '');
  const search = new URLSearchParams(location.search);
  const current = activeItem(groups, rest);
  const currentSub = current?.sub?.find((s) => subActive(s, rest, search, current.sub!));
  const wsName = workspaces.data?.find((w) => w.id === ws)?.name ?? 'Workspace';

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!c));
      } catch {
        // Storage may be unavailable; the choice still applies for this page.
      }
      return !c;
    });

  // Ctrl K / ⌘ K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The page slot below exists from here on: single-spa may mount lifecycle modules into it.
  useEffect(startModules, []);
  // A new page closes the drawer on narrow screens.
  useEffect(() => setDrawer(false), [location.pathname]);

  return (
    <div className={`app ${collapsed ? 'nav-collapsed' : ''} ${drawer ? 'drawer-open' : ''}`}>
      <Sidebar ws={ws!} groups={groups} workspaces={workspaces.data ?? []} collapsed={collapsed && !drawer} onToggle={toggle} onNavigate={() => setDrawer(false)} />
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden />}
      <div className="app-main">
        <header className="topbar">
          <button type="button" className="nav-icon-button menu-button" aria-label="Open navigation" onClick={() => setDrawer(true)}>
            <IconMenu2 size={20} stroke={1.6} aria-hidden />
          </button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <ol>
              <li>
                <Link to={`/w/${ws}`}>{wsName}</Link>
              </li>
              {current && (
                <li aria-current={currentSub ? undefined : 'page'}>
                  {currentSub ? <Link to={current.to ? `/w/${ws}/${current.to}` : `/w/${ws}`}>{current.label}</Link> : current.label}
                </li>
              )}
              {currentSub && <li aria-current="page">{currentSub.label}</li>}
            </ol>
          </nav>
          <div className="spacer" />
          <button type="button" className="search-button" onClick={() => setSearching(true)} aria-label="Search pages, elements and queries">
            <IconSearch size={16} stroke={1.8} aria-hidden />
            <span className="search-hint">Search</span>
            <kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K'}</kbd>
          </button>
          <div className="user">
            <span>{(user?.profile.preferred_username as string | undefined) ?? user?.profile.email}</span>
            <span className="muted small roles" title={roles?.join(', ')}>
              {roles?.join(', ')}
            </span>
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
          <ViewProvider workspaceId={ws!}>
            {/* Pages are lazy chunks; the shell stays while one loads. */}
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </ViewProvider>
          {/* Lifecycle modules render here (lifecycle.ts), each in a tree of its own. */}
          <div id="d4-module-slot" />
        </main>
      </div>
      <CommandPalette ws={ws!} groups={groups} open={searching} onClose={() => setSearching(false)} />
    </div>
  );
}
