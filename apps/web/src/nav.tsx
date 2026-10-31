import {
  IconArrowsDiff,
  IconDatabaseExport,
  IconDatabaseSearch,
  IconFileImport,
  IconFlask,
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
import type { Access, ManifestItem, NavContribution, NavGroup, NavItem, NavSub } from '@d4/web-platform';
import { moduleStates } from './lifecycle';

export type { NavGroup, NavItem };

/** The whole navigation, from every module's contribution: the sidebar, breadcrumb and search read it. */
function buildNav(contributions: NavContribution[]): NavGroup[] {
  const groups = new Map<string, { order: number; items: NavItem[] }>();
  for (const nav of contributions) {
    const g = groups.get(nav.group) ?? { order: nav.order, items: [] };
    g.items.push(...nav.items);
    groups.set(nav.group, g);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    // A stable sort: items without an order keep the order their module lists them in.
    .map(([label, g]) => ({ label, items: [...g.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }));
}

/** Icons lifecycle modules may name in their manifest. */
const ICONS: Record<string, Icon> = {
  'arrows-diff': IconArrowsDiff,
  'database-export': IconDatabaseExport,
  'database-search': IconDatabaseSearch,
  'file-import': IconFileImport,
  flask: IconFlask,
  gavel: IconGavel,
  'git-pull-request': IconGitPullRequest,
  hierarchy: IconHierarchy3,
  'list-check': IconListCheck,
  'plug-connected': IconPlugConnected,
  report: IconReport,
  settings: IconSettings,
  table: IconTable,
  timeline: IconTimeline,
};

const fromManifest = (i: ManifestItem): NavItem => ({
  ...i,
  icon: ICONS[i.icon] ?? IconFlask,
  visible: i.requires && ((a) => a[i.requires!]),
  sub: i.sub?.map((s) => ({ ...s, visible: s.requires && ((a) => a[s.requires!]) })),
});

/** The navigation as this user may see it: every lifecycle module loaded so far. */
export function visibleNav(a: Access): NavGroup[] {
  const loaded = [...moduleStates().values()].flatMap((s) => (s.status === 'ready' ? [{ ...s.manifest.nav, items: s.manifest.nav.items.map(fromManifest) }] : []));
  return buildNav(loaded).map((g) => ({
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
