import type { QueryClient } from '@tanstack/react-query';
import type { D4Client } from '@d4/sdk';
import type { Access } from './access';
import type { RuntimeConfig } from './config';

/**
 * The contract version of lifecycle modules (P6 spike): an ES module that exports a `manifest`
 * and the single-spa lifecycles `bootstrap`, `mount` and `unmount`. Nothing in it is tied to React:
 * a module may use any framework, or none.
 */
export const LIFECYCLE_CONTRACT = 2;

/**
 * What the shell hands every lifecycle module in its props. Framework-neutral; React modules
 * wrap it with `ModuleRoot`. Module-level state (sign-in, settings, the API client) lives here, not
 * in React context, because each module renders in a tree of its own.
 */
export interface Platform {
  config: Readonly<RuntimeConfig>;
  /** The signed-in user's access token, renewed by the shell. */
  token(): Promise<string>;
  /** The typed API client, signed in as the current user. */
  client(): D4Client;
  /** The shell's query cache: modules share fetched data and invalidations with it. */
  queryClient: QueryClient;
  /** The workspace id in the current URL, if any. */
  workspace(): string | undefined;
  /** Goes to an app URL; every module's router follows. */
  navigate(to: string): void;
}

/** Props single-spa passes to each lifecycle function. */
export interface LifecycleProps {
  name: string;
  platform: Platform;
  /** The element the module renders into (inside the shell's page area). */
  domElementGetter(): HTMLElement;
}

export interface ManifestSub {
  label: string;
  /** Path under the workspace, as in `NavSub`. */
  to: string;
  requires?: keyof Access;
}

/** A menu item as data: the icon is a name the shell maps to its icon set. */
export interface ManifestItem {
  id: string;
  label: string;
  icon: string;
  to: string;
  match: string[];
  sub?: ManifestSub[];
  requires?: keyof Access;
  order?: number;
}

/**
 * What a lifecycle module tells the shell before it is mounted. The module owns every path under
 * `/w/:ws/<id>`; the shell builds the menu from `nav`.
 */
export interface ModuleManifest {
  id: string;
  contract: typeof LIFECYCLE_CONTRACT;
  nav: { group: string; order: number; items: ManifestItem[] };
}

type Lifecycle = (props: LifecycleProps) => Promise<unknown>;

/** A lifecycle module's exports. */
export interface LifecycleModule {
  manifest: ModuleManifest;
  bootstrap: Lifecycle | Lifecycle[];
  mount: Lifecycle | Lifecycle[];
  unmount: Lifecycle | Lifecycle[];
}

const sheets = new Map<string, Promise<void>>();

/** Adds a module's stylesheet to the page once; resolves when it has loaded. */
export const loadStylesheet = (href: string): Promise<void> => {
  let p = sheets.get(href);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Stylesheet ${href} did not load`));
      document.head.append(link);
    });
    sheets.set(href, p);
  }
  return p;
};
