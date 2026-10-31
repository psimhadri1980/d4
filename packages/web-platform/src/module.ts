import type { Icon } from '@tabler/icons-react';
import { lazy, type ComponentType } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { Access } from './access';

/** The contract version this build of the shell understands; it refuses modules with another. */
export const MODULE_CONTRACT = 1;

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
  /** Position within its group when several modules add to it (low first). */
  order?: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** What a module adds to the navigation: items in a group, placed by `order` (low first). */
export interface NavContribution {
  group: string;
  /** The group's place in the sidebar; modules sharing a group give the same value. */
  order: number;
  items: NavItem[];
}

/**
 * A web module: a slice of the app (explore, queries, plan, data, reporting, admin) that owns
 * its screens and menu items. The shell mounts `routes` under `/w/:ws` and builds the sidebar,
 * breadcrumb and search from every module's `nav`. A module imports only `@d4/web-platform`,
 * `@d4/ui-kit` and domain packages, never another module.
 */
export interface D4Module {
  id: string;
  contract: typeof MODULE_CONTRACT;
  nav: NavContribution;
  /** Relative to `/w/:ws`; pages are React.lazy chunks. */
  routes: RouteObject[];
}

/**
 * A page as a lazy chunk, from a module file's named export:
 * `const Jobs = lazyPage(() => import('./Jobs'), 'Jobs');`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any props, as React.lazy itself allows
export const lazyPage = <M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));
