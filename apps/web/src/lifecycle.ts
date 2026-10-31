import { addErrorHandler, getAppStatus, navigateToUrl, registerApplication, start } from 'single-spa';
import { config, d4, accessToken, LIFECYCLE_CONTRACT, type LifecycleModule, type ModuleManifest, type Platform } from '@d4/web-platform';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Lifecycle modules (P6 spike): ES modules named in /config.json that the shell imports after it
 * has rendered and registers with single-spa. Each owns `/w/:ws/<name>/…` and renders into the
 * page slot; the menu is built from its manifest. The shell never waits for one.
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

/** Imports and registers every module in /config.json, in parallel; each one's state is published as it settles. */
export function loadLifecycleModules(platform: Platform): void {
  addErrorHandler((err) => {
    console.error(`D4 module '${err.appOrParcelName}' failed (${getAppStatus(err.appOrParcelName) ?? 'unknown'})`, err);
    set(err.appOrParcelName, { status: 'failed', error: err.message });
  });
  for (const { name, entry } of config.remotes ?? []) {
    set(name, { status: 'loading' });
    withTimeout(import(/* @vite-ignore */ entryFor(name, entry)) as Promise<LifecycleModule>, `Module '${name}'`)
      .then((m) => {
        if (m.manifest?.contract !== LIFECYCLE_CONTRACT) throw new Error(`uses contract ${String(m.manifest?.contract)}; this app understands ${LIFECYCLE_CONTRACT}`);
        if (m.manifest.id !== name) throw new Error(`calls itself '${m.manifest.id}'`);
        const prefix = new RegExp(`^/w/[^/]+/${name}(/|$)`);
        registerApplication({ name, app: m, activeWhen: (l) => prefix.test(l.pathname), customProps: { platform, domElementGetter: () => slotFor(name) } });
        set(name, { status: 'ready', manifest: m.manifest });
      })
      .catch((e: unknown) => {
        console.error(`D4 module '${name}' is unavailable:`, e);
        set(name, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
      });
  }
}

let started = false;
/** Lets single-spa mount modules; called once the shell's page slot exists (Layout). */
export function startModules(): void {
  if (!started) start({ urlRerouteOnly: true });
  started = true;
}
