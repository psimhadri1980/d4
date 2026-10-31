import type { Access, D4Module, NavGroup, NavItem, NavSub } from '@d4/web-platform';
import { MODULES } from './modules';

export type { NavGroup, NavItem };

/** The whole navigation, from every module's contribution: the sidebar, breadcrumb and search read it. */
function buildNav(modules: D4Module[]): NavGroup[] {
  const groups = new Map<string, { order: number; items: NavItem[] }>();
  for (const { nav } of modules) {
    const g = groups.get(nav.group) ?? { order: nav.order, items: [] };
    g.items.push(...nav.items);
    groups.set(nav.group, g);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    // A stable sort: items without an order keep the order their module lists them in.
    .map(([label, g]) => ({ label, items: [...g.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }));
}

const NAV = buildNav(MODULES);

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
