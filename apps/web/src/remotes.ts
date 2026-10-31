import { loadRemote, registerRemotes } from '@module-federation/runtime';
import { config, type D4Module } from '@d4/web-platform';

/** Modules loaded from remotes at start-up; the shell mounts them after its own. */
export const remoteModules: D4Module[] = [];

const TIMEOUT_MS = 8000;

const withTimeout = <T,>(p: Promise<T>, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not load within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS))]);

/**
 * Registers the remotes named in /config.json and loads each one's `./module` descriptor in
 * parallel. A remote that fails is left out (logged); the rest of the app starts anyway.
 */
export async function loadRemoteModules(): Promise<void> {
  const remotes = config.remotes ?? [];
  if (!remotes.length) return;
  // Vite remotes build their entry as an ES module.
  registerRemotes(remotes.map((r) => ({ name: r.name, entry: r.entry, type: 'module' })));
  const results = await Promise.allSettled(
    remotes.map((r) => withTimeout(loadRemote<Record<string, unknown>>(`${r.name}/module`), `Remote '${r.name}'`)),
  );
  results.forEach((res, i) => {
    const name = remotes[i]!.name;
    if (res.status === 'rejected') return console.error(`D4 remote '${name}' is unavailable:`, res.reason);
    const mod = Object.values(res.value ?? {}).find((v): v is D4Module => !!v && typeof v === 'object' && 'contract' in v && 'routes' in v);
    if (mod) remoteModules.push(mod);
    else console.error(`D4 remote '${name}' exposes no module descriptor`);
  });
}
