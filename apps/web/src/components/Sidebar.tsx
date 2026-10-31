import { IconChevronDown, IconChevronRight, IconFolders, IconHexagons, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { activeItem, subActive, type NavGroup, type NavItem } from '../nav';
import { type Workspace } from '@d4/web-platform';

interface Props {
  ws: string;
  groups: NavGroup[];
  workspaces: Workspace[];
  collapsed: boolean;
  onToggle(): void;
  /** Narrow screens: the sidebar is a drawer; following a link closes it. */
  onNavigate(): void;
}

/**
 * Left navigation: grouped menus with sub-items. Collapsed it is an icon rail where hovering or
 * focusing an icon shows a flyout with its name and sub-items; expanded it shows labels and
 * opens the current menu's sub-items.
 */
export function Sidebar({ ws, groups, workspaces, collapsed, onToggle, onNavigate }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const rest = location.pathname.replace(new RegExp(`^/w/${ws}/?`), '');
  const search = new URLSearchParams(location.search);
  const current = activeItem(groups, rest);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // The menu you are in opens by itself (others keep what you chose).
  useEffect(() => {
    if (current?.sub?.length) setOpen((o) => ({ ...o, [current.id]: true }));
  }, [current?.id, current?.sub?.length]);
  const base = `/w/${ws}`;
  const href = (to: string) => (to ? `${base}/${to}` : base);

  const item = (i: NavItem) => {
    const active = current?.id === i.id;
    const Icon = i.icon;
    const subs = i.sub ?? [];
    const expanded = !collapsed && !!open[i.id];
    return (
      <li key={i.id} className={`nav-item ${active ? 'active' : ''}`}>
        <div className="nav-row">
          <Link to={href(i.to)} className="nav-link" aria-label={i.label} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
            <Icon size={20} stroke={1.6} aria-hidden />
            <span className="nav-label">{i.label}</span>
          </Link>
          {subs.length > 0 && !collapsed && (
            <button
              type="button"
              className="nav-chevron"
              aria-expanded={expanded}
              aria-controls={`nav-sub-${i.id}`}
              aria-label={`${expanded ? 'Hide' : 'Show'} ${i.label} pages`}
              onClick={() => setOpen((o) => ({ ...o, [i.id]: !o[i.id] }))}
            >
              {expanded ? <IconChevronDown size={16} aria-hidden /> : <IconChevronRight size={16} aria-hidden />}
            </button>
          )}
        </div>
        {expanded && subs.length > 0 && (
          <ul className="nav-sub" id={`nav-sub-${i.id}`}>
            {subs.map((s) => {
              const on = subActive(s, rest, search, subs);
              return (
                <li key={s.to}>
                  <Link to={href(s.to)} aria-current={on ? 'page' : undefined} className={on ? 'active' : ''} onClick={onNavigate}>
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {collapsed && (
          // Flyout for the icon rail: the name, and the sub-items when there are any.
          <div className="nav-flyout" role="group" aria-label={`${i.label} pages`}>
            {/* The icon itself is the link; the title only names it. */}
            <div className="nav-flyout-title" aria-hidden>
              {i.label}
            </div>
            {subs.map((s) => (
              <Link key={s.to} to={href(s.to)} className={subActive(s, rest, search, subs) ? 'active' : ''} onClick={onNavigate}>
                {s.label}
              </Link>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-head">
        <Link to={base} className="brand" aria-label="D4 home" onClick={onNavigate}>
          <IconHexagons size={22} stroke={1.6} aria-hidden />
          <span className="nav-label">D4</span>
        </Link>
        {collapsed ? (
          <button type="button" className="nav-icon-button" aria-label="Choose workspace" title="Workspace" onClick={onToggle}>
            <IconFolders size={20} stroke={1.6} aria-hidden />
          </button>
        ) : (
          <label className="ws-picker">
            <span className="sr-only">Workspace</span>
            <IconFolders size={18} stroke={1.6} aria-hidden />
            <select aria-label="Workspace" value={ws} onChange={(e) => (navigate(`/w/${e.target.value}`), onNavigate())}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Link to={`${base}/new`} className="button primary nav-new" aria-label="New element" title={collapsed ? 'New element' : undefined} onClick={onNavigate}>
          <IconPlus size={18} stroke={2} aria-hidden />
          <span className="nav-label">New element</span>
        </Link>
      </div>
      <div className="sidebar-scroll">
        {groups.map((g) => (
          <section key={g.label} className="nav-group" aria-label={g.label}>
            <h2 className="nav-group-label">{g.label}</h2>
            <ul>{g.items.map(item)}</ul>
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <button type="button" className="nav-icon-button nav-toggle" onClick={onToggle} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : undefined}>
          {collapsed ? <IconLayoutSidebarLeftExpand size={20} stroke={1.6} aria-hidden /> : <IconLayoutSidebarLeftCollapse size={20} stroke={1.6} aria-hidden />}
          <span className="nav-label">Collapse</span>
        </button>
      </div>
    </nav>
  );
}
