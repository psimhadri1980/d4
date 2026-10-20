import {
  IconArrowsDiff,
  IconDatabaseExport,
  IconDatabaseSearch,
  IconFileImport,
  IconGavel,
  IconGitPullRequest,
  IconHierarchy3,
  IconListCheck,
  IconPlugConnected,
  IconReport,
  IconSettings,
  IconTable,
  IconTimeline,
  type Icon,
} from '@tabler/icons-react';

/** Who sees a menu item. Hidden items are not rendered at all (the API still enforces access). */
export interface Access {
  admin: boolean;
  author: boolean;
  steward: boolean;
}

export interface NavSub {
  label: string;
  /** Path under the workspace (no leading slash), with an optional query string. */
  to: string;
  visible?: (a: Access) => boolean;
}

export interface NavItem {
  id: string;
  label: string;
  icon: Icon;
  to: string;
  /** Path prefixes (under the workspace) that count as being in this item. */
  match: string[];
  sub?: NavSub[];
  visible?: (a: Access) => boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const admins = (a: Access) => a.admin;

/** The whole navigation: groups, menus and sub-items. The sidebar, breadcrumb and search read it. */
export const NAV: NavGroup[] = [
  {
    label: 'Explore',
    items: [
      // Explorer is the workspace home and covers element pages and the element editor.
      { id: 'explorer', label: 'Explorer', icon: IconHierarchy3, to: '', match: ['', 'e/', 'new'] },
      {
        id: 'queries',
        label: 'Queries',
        icon: IconDatabaseSearch,
        to: 'queries',
        match: ['queries', 'catalog', 'studio', 'stewardship'],
        sub: [
          { label: 'Catalog', to: 'queries?section=catalog' },
          { label: 'Query studio', to: 'queries?section=studio', visible: (a) => a.author },
          { label: 'Stewardship', to: 'queries?section=stewardship', visible: (a) => a.steward },
        ],
      },
      {
        id: 'matrices',
        label: 'Matrices',
        icon: IconTable,
        to: 'matrices',
        match: ['matrices'],
        sub: [
          { label: 'CRUD-I', to: 'matrices' },
          { label: 'Capability × application', to: 'matrices?kind=capability-application' },
          { label: 'Data-store roles', to: 'matrices?kind=data-store-roles' },
          { label: 'Lifecycle heat-map', to: 'matrices?kind=lifecycle' },
        ],
      },
      { id: 'compare', label: 'Compare', icon: IconArrowsDiff, to: 'compare', match: ['compare'] },
    ],
  },
  {
    label: 'Plan and govern',
    items: [
      { id: 'roadmap', label: 'Roadmap', icon: IconTimeline, to: 'roadmap', match: ['roadmap'] },
      { id: 'decisions', label: 'Decisions', icon: IconGavel, to: 'decisions', match: ['decisions'] },
      {
        id: 'proposals',
        label: 'Proposals',
        icon: IconGitPullRequest,
        to: 'proposals',
        match: ['proposals'],
        sub: [
          { label: 'Open', to: 'proposals?show=open' },
          { label: 'Waiting for review', to: 'proposals?show=review' },
          { label: 'Closed', to: 'proposals?show=closed' },
        ],
      },
    ],
  },
  {
    label: 'Data management',
    items: [
      { id: 'import', label: 'Import', icon: IconFileImport, to: 'import', match: ['import'] },
      { id: 'connectors', label: 'Connectors', icon: IconPlugConnected, to: 'connectors', match: ['connectors'], visible: admins },
      { id: 'backups', label: 'Backups', icon: IconDatabaseExport, to: 'backups', match: ['backups'], visible: admins },
    ],
  },
  {
    label: 'Reporting',
    items: [
      { id: 'reports', label: 'Reports', icon: IconReport, to: 'reports', match: ['reports'] },
      { id: 'jobs', label: 'Jobs', icon: IconListCheck, to: 'jobs', match: ['jobs'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        id: 'admin',
        label: 'Admin',
        icon: IconSettings,
        to: 'admin/workspaces',
        match: ['admin'],
        visible: admins,
        sub: [
          { label: 'Workspaces', to: 'admin/workspaces' },
          { label: 'People and roles', to: 'admin/people' },
          { label: 'Webhooks', to: 'admin/webhooks' },
          { label: 'Usage', to: 'admin/usage' },
        ],
      },
    ],
  },
];

/** The navigation as this user may see it. */
export function visibleNav(a: Access): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.visible || i.visible(a)).map((i) => ({ ...i, ...(i.sub && { sub: i.sub.filter((s) => !s.visible || s.visible(a)) }) })),
  })).filter((g) => g.items.length);
}

/** `rest` is the path after `/w/:ws/` (no leading slash). */
export function activeItem(groups: NavGroup[], rest: string): NavItem | undefined {
  const items = groups.flatMap((g) => g.items);
  const hit = (m: string) => (m === '' ? rest === '' : m.endsWith('/') ? rest.startsWith(m) : rest === m || rest.startsWith(`${m}/`));
  return items.find((i) => i.match.some(hit));
}

/** Whether a sub-item is the one being shown (path and every query parameter it sets). */
export function subActive(sub: NavSub, rest: string, search: URLSearchParams, siblings: NavSub[]): boolean {
  const [path, query = ''] = sub.to.split('?');
  if (rest !== path) return false;
  const want = new URLSearchParams(query);
  if ([...want].length) return [...want].every(([k, v]) => search.get(k) === v);
  // A sub-item without parameters is active when no sibling's parameters are set (the default view).
  return !siblings.some((s) => s !== sub && s.to.startsWith(`${path}?`) && [...new URLSearchParams(s.to.split('?')[1])].every(([k, v]) => search.get(k) === v));
}
