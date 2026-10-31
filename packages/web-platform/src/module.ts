import type { Icon } from '@tabler/icons-react';
import { lazy, type ComponentType } from 'react';
import type { Access } from './access';

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

/** What a module adds to the navigation (its manifest's `nav`, with icons resolved): items in a group, placed by `order` (low first). */
export interface NavContribution {
  group: string;
  /** The group's place in the sidebar; modules sharing a group give the same value. */
  order: number;
  items: NavItem[];
}

/**
 * A page as a lazy chunk, from a module file's named export:
 * `const Jobs = lazyPage(() => import('./Jobs'), 'Jobs');`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any props, as React.lazy itself allows
export const lazyPage = <M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));
