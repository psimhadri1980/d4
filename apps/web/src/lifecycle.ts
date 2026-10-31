import { addErrorHandler, getAppStatus, navigateToUrl, registerApplication, start, unregisterApplication } from 'single-spa';
import { config, d4, accessToken, lifecycleProblems, ownedPaths, type LifecycleModule, type ModuleManifest, type Platform } from '@d4/web-platform';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Lifecycle modules (D64): ES modules listed in the tenant's module registry (/v1/web-modules) that
 * the shell imports after it has rendered and registers with single-spa. Each owns
 * `/w/:ws/<path>/…` for its manifest's paths (default its name) and renders into the page slot; the menu is built from its manifest. The shell
 * never waits for one, and follows registry changes while it runs (hot loading).
 */
type ModuleState = { status: 'loading' } | { status: 'ready'; manifest: ModuleManifest } | { status: 'failed'; error: string };

const states = new Map<string, ModuleState>();
const listeners = new Set<() => void>();
let version = 0;

const set = (name: string, s: ModuleState) => {
  states.set(name, s);
  version++;
  listeners.forEach((l) => l());
};

export const moduleStates = (): ReadonlyMap<string, ModuleState> => states;

/**
 * The module that owns a path segment under the workspace: a loaded one whose manifest lists it,
 * else one of that name (still loading or failed, its paths not known yet).
 */
export function moduleFor(segment: string): ModuleState | undefined {
  for (const s of states.values()) if (s.status === 'ready' && (segment === '' ? s.manifest.home : ownedPaths(s.manifest).includes(segment))) return s;
  return states.get(segment);
}
/** Whether any module is still loading, or failed: either may own a path nothing else claims. */
export const pendingModules = () => ({
  loading: [...states.values()].some((s) => s.status === 'loading'),
  failed: [...states.values()].some((s) => s.status === 'failed'),
});
export const subscribeModules = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const modulesVersion = () => version;

const TIMEOUT_MS = 8000;

/** `localStorage['d4:module:<name>'] = '<url>'` loads that module from elsewhere, e.g. its dev server. */
const entryFor = (name: string, entry: string) => {
  try {
    return localStorage.getItem(`d4:module:${name}`) || entry;
  } catch {
    return entry;
  }
};

const withTimeout = <T,>(p: Promise<T>, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not load within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS))]);

/** The page slot's element for one module, created on first mount. */
function slotFor(name: string): HTMLElement {
  const slot = document.getElementById('d4-module-slot');
  if (!slot) throw new Error('The page slot is not on the page');
  let el = slot.querySelector<HTMLElement>(`[data-module="${name}"]`);
  if (!el) {
    el = Object.assign(document.createElement('div'), { className: 'module-root' });
    el.dataset.module = name;
    slot.append(el);
  }
  return el;
}

export function createPlatform(queryClient: QueryClient): Platform {
  return {
    config,
    token: accessToken,
    client: d4,
    queryClient,
    workspace: () => /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1],
    navigate: navigateToUrl,
  };
}

interface Listed {
  name: string;
  entry: string;
  version: string;
}

/** What is registered with single-spa now, by name: the release it came from. */
const registered = new Map<string, string>();
let ready = false;
let failed = false;

/** Whether the registry has answered once (until then a module path shows "Loading…"), and whether that failed. */
export const registryState = () => ({ ready, failed });

const release = (m: Listed) => `${m.entry}@${m.version}`;

/** Imports one module and registers it with single-spa; its state is published as it settles. */
async function load(platform: Platform, m: Listed): Promise<void> {
  const { name } = m;
  set(name, { status: 'loading' });
  // The version in the URL makes a new release a new ES module; the browser caches each one.
  const url = entryFor(name, `${m.entry}?v=${encodeURIComponent(m.version)}`);
  try {
    const mod = await withTimeout(import(/* @vite-ignore */ url) as Promise<LifecycleModule>, `Module '${name}'`);
    const problems = lifecycleProblems(mod, name, __D4_SHARED__);
    if (problems.length) throw new Error(problems.join('; '));
    if (registered.get(name) !== release(m)) return; // superseded while loading
    const owned = `/(${ownedPaths(mod.manifest).join('|')})(/|$)`;
    const prefix = new RegExp(`^/w/[^/]+(${owned}${mod.manifest.home ? '|/?$' : ''})`);
    registerApplication({ name, app: mod, activeWhen: (l) => prefix.test(l.pathname), customProps: { platform, domElementGetter: () => slotFor(name) } });
    set(name, { status: 'ready', manifest: mod.manifest });
  } catch (e) {
    console.error(`D4 module '${name}' is unavailable:`, e);
    set(name, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Takes a module out: single-spa unmounts it if it is showing, and its menu items go. While a
 * new release replaces it (`swapping`), its paths show "Loading…" instead of leaving the page.
 */
async function drop(name: string, swapping: boolean): Promise<void> {
  registered.delete(name);
  if (swapping) set(name, { status: 'loading' });
  if (getAppStatus(name) !== null) await unregisterApplication(name);
  if (!swapping) {
    states.delete(name);
    version++;
    listeners.forEach((l) => l());
  }
}

let etag: string | undefined;

/**
 * Brings the page in line with the registry (/v1/web-modules): loads new modules, swaps a module
 * whose release changed (unmount, import the new entry, mount) and removes ones taken out.
 */
async function sync(platform: Platform): Promise<void> {
  try {
    const res = await fetch(`${platform.config.apiUrl}/v1/web-modules`, {
      headers: { authorization: `Bearer ${await platform.token()}`, ...(etag && { 'if-none-match': etag }) },
      cache: 'no-store',
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`/v1/web-modules answered ${res.status}`);
    etag = res.headers.get('etag') ?? undefined;
    const { modules } = (await res.json()) as { modules: Listed[] };
    const wanted = new Map(modules.map((m) => [m.name, m]));
    for (const name of [...registered.keys()]) {
      const m = wanted.get(name);
      if (!m || registered.get(name) !== release(m)) await drop(name, !!m);
    }
    const added = modules.filter((m) => !registered.has(m.name));
    added.forEach((m) => registered.set(m.name, release(m)));
    failed = false;
    await Promise.all(added.map((m) => load(platform, m)));
  } catch (e) {
    console.error('D4 could not read the module registry:', e);
    failed = true;
  } finally {
    if (!ready || failed) {
      ready = true;
      version++;
      listeners.forEach((l) => l());
    }
  }
}

/** How often the shell checks the registry while the page is open (and whenever it comes back into view). */
const POLL_MS = 30_000;
let platformRef: Platform | undefined;

/** Called once at start-up with the platform modules will receive. */
export function initModules(platform: Platform): void {
  platformRef = platform;
}

let started = false;
/**
 * Starts module loading once signed in and the page slot exists (Layout): reads the registry,
 * lets single-spa mount, and keeps checking for changes.
 */
export function startModules(): void {
  if (started || !platformRef) return;
  started = true;
  const platform = platformRef;
  addErrorHandler((err) => {
    console.error(`D4 module '${err.appOrParcelName}' failed`, err);
    set(err.appOrParcelName, { status: 'failed', error: err.message });
  });
  start({ urlRerouteOnly: true });
  void sync(platform);
  setInterval(() => document.visibilityState === 'visible' && void sync(platform), POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void sync(platform));
}
