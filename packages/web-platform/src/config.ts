/**
 * Public settings read at start-up from `/config.json`, which the web container writes from its
 * environment (deploy/web/config.sh) and Vite serves in development (apps/web/vite.config.ts), so one
 * build runs in any environment.
 */
export interface RuntimeConfig {
  apiUrl: string;
  oidcAuthority: string;
  oidcClientId: string;
}

export const config = {} as RuntimeConfig;

/** Fills `config`; must finish before anything reads it (the web app loads its UI afterwards). */
export async function loadRuntimeConfig(): Promise<void> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/config.json answered ${res.status}`);
  const loaded = (await res.json()) as Partial<RuntimeConfig>;
  const missing = (['apiUrl', 'oidcAuthority', 'oidcClientId'] as const).filter((k) => typeof loaded[k] !== 'string' || !loaded[k]);
  if (missing.length) throw new Error(`/config.json is missing ${missing.join(', ')}`);
  // Paths are resolved against this page's origin, so every gateway host uses its own API and issuer.
  const absolute = (v: string) => new URL(v, location.origin).href.replace(/\/$/, '');
  Object.assign(config, loaded, { apiUrl: absolute(loaded.apiUrl!), oidcAuthority: absolute(loaded.oidcAuthority!) });
}
