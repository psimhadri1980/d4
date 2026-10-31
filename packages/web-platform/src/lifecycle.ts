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

const isLifecycle = (v: unknown) => typeof v === 'function' || (Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === 'function'));

/**
 * What is wrong with a module's exports, if anything: the contract a module must meet to load.
 * The shell checks every module it imports; each module's tests check their own exports.
 */
export function lifecycleProblems(mod: unknown, name: string): string[] {
  const m = (mod ?? {}) as Partial<LifecycleModule>;
  const out: string[] = [];
  if (m.manifest?.contract !== LIFECYCLE_CONTRACT) out.push(`uses contract ${String(m.manifest?.contract)}; this app understands ${LIFECYCLE_CONTRACT}`);
  else if (m.manifest.id !== name) out.push(`calls itself '${m.manifest.id}'`);
  for (const k of ['bootstrap', 'mount', 'unmount'] as const) if (!isLifecycle(m[k])) out.push(`does not export ${k} as a function or a list of functions`);
  const nav = m.manifest?.nav;
  if (m.manifest && (!nav || typeof nav.group !== 'string' || typeof nav.order !== 'number' || !Array.isArray(nav.items))) out.push('has no menu (nav.group, nav.order, nav.items)');
  for (const item of nav?.items ?? []) {
    if (![item.id, item.label, item.icon, item.to].every((v) => typeof v === 'string' && v)) out.push(`menu item '${item.id}' lacks id, label, icon or to`);
    // Paths are relative to the workspace and must stay within the module's own `<name>/…`.
    for (const to of [item.to, ...(item.sub ?? []).map((s) => s.to)]) if (!(to === name || to?.startsWith(`${name}/`))) out.push(`menu path '${to}' is outside ${name}/`);
  }
  return out;
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
