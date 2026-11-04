// Settings: the shared env files in run/env, host.conf (the one entry point), what dependencies
// provide and each component's own env, merged into run/.run/env/<runtime>/<component>.env, the
// one file both `podman run --env-file` and local Node processes read.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { capture, log, RunError } from './log.ts';
import { component, dependencies, loadComponents, mainPort, ROOT, RUN_DIR, STATE_DIR, type Component, type Runtime } from './components.ts';

export const ENGINE = process.env['D4_CONTAINER_ENGINE'] || 'podman';
/** `D4_PROFILE=prod`: run/env/prod.env on top, no development secrets. */
const PROFILE = process.env['D4_PROFILE'] || 'dev';

/** Flat KEY=value lines (comments and blank lines skipped), as bash, Podman and Node read them. */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(#|$)/.test(line)) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new RunError(`${file}:${i + 1}: expected KEY=value, found '${line}'`);
    out[m[1]!] = m[2]!.trim();
  });
  return out;
}

/** `${VAR}`, `${VAR:-default}` and `${VAR:?message}` from the pool. */
export function interpolate(value: string, pool: Record<string, string>, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*))?\}/g, (_m, key: string, op?: string, arg?: string) => {
    const v = pool[key];
    if (v !== undefined && v !== '') return v;
    if (op === '-') return arg ?? '';
    if (op === '?') throw new RunError(`${where}: ${key} is not set${arg ? ` (${arg})` : ''}`);
    return v ?? '';
  });
}

let base: Record<string, string> | undefined;

/** Copies ORG_CA_FILE / GATEWAY_TLS_*_FILE into run/certs, where builds and containers read them. */
function stageCerts(env: Record<string, string>): void {
  const certs = join(RUN_DIR, 'certs');
  for (const [key, file] of [['ORG_CA_FILE', 'org-ca.crt'], ['GATEWAY_TLS_CERT_FILE', 'gateway.crt'], ['GATEWAY_TLS_KEY_FILE', 'gateway.key']] as const) {
    let src = env[key];
    if (!src) continue;
    src = src.replace(/^~(?=\/)/, homedir());
    if (!isAbsolute(src)) src = join(RUN_DIR, src);
    if (!existsSync(src) || statSync(src).size === 0) throw new RunError(`${key} points at ${env[key]}, which is missing or empty`, { hint: 'fix it in run/env/local.env or run/env/common.env' });
    const dst = join(certs, file);
    if (!existsSync(dst) || !readFileSync(dst).equals(readFileSync(src))) {
      copyFileSync(src, dst);
      log.detail(`copied ${key} (${src}) to run/certs/${file}`);
    }
  }
}

/**
 * The variables every component's settings are drawn from: run/env/*.env, host.conf, then what
 * is derived from them (public URLs, ports, certificates). The caller's environment wins.
 */
export function baseEnv(): Record<string, string> {
  if (base) return base;
  const files = ['env/common.env', 'env/images.env', ...(PROFILE === 'prod' ? ['env/prod.env'] : ['env/dev-secrets.env']), '../host.conf', 'env/local.env'];
  const env: Record<string, string> = {};
  for (const f of files) Object.assign(env, readEnvFile(join(RUN_DIR, f)));
  for (const k of Object.keys(env)) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  stageCerts(env);
  const scheme = env['D4_SCHEME'] || 'http';
  const port = env['D4_PORT'] || '5173';
  const deflt = (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const url = `${scheme}://${env['D4_HOST'] || 'localhost'}${deflt ? '' : ':' + port}`;
  const ca = existsSync(join(RUN_DIR, 'certs/org-ca.crt')) && statSync(join(RUN_DIR, 'certs/org-ca.crt')).size > 0;
  const tls = existsSync(join(RUN_DIR, 'certs/gateway.crt')) && existsSync(join(RUN_DIR, 'certs/gateway.key'));
  const derived: Record<string, string> = {
    D4_ROOT: ROOT,
    D4_PUBLIC_URL: url,
    D4_PUBLIC_API_URL: `${url}/api`,
    OIDC_ISSUER: `${url}/auth/realms/d4`,
    D4_PORT: port,
    // Organization CA: the path inside image builds, inside containers and on the host.
    D4_CA_BUILD: ca ? '/etc/org-certs/org-ca.crt' : '',
    D4_CA_RUN: ca ? '/run/d4-certs/org-ca.crt' : '',
    D4_CA_HOST: ca ? join(RUN_DIR, 'certs/org-ca.crt') : '',
    GATEWAY_TLS_CERT: tls ? '/run/d4-certs/gateway.crt' : '',
    GATEWAY_TLS_KEY: tls ? '/run/d4-certs/gateway.key' : '',
    NPM_REGISTRY: env['NPM_REGISTRY'] || 'https://registry.npmjs.org',
  };
  // PORT_<NAME> (first port) and PORT_<NAME>_<KEY> for every component, and the web modules a
  // local process may serve (the gateway's GATEWAY_MODULES).
  const modules: string[] = [];
  for (const comp of loadComponents().values()) {
    const id = comp.name.toUpperCase().replace(/-/g, '_');
    const main = mainPort(comp);
    if (main) derived[`PORT_${id}`] = String(main);
    for (const [k, p] of Object.entries(comp.ports)) derived[`PORT_${id}_${k.toUpperCase()}`] = String(p);
    if (comp.runtimes.podman?.via === 'ui-modules' && main) modules.push(`${comp.name.replace(/^web-/, '')}=${main}`);
  }
  derived['D4_LOCAL_MODULES'] = modules.join(' ');
  for (const [k, v] of Object.entries(derived)) if (env[k] === undefined || env[k] === '' || k.startsWith('PORT_')) env[k] = v;
  for (const k of Object.keys(env)) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  base = env;
  return env;
}

/** `neo4j=127.0.0.1:7687,d4-neo4j-t_acme=127.0.0.1:7701`: how every process reaches each tenant graph. */
function neo4jHosts(): string {
  const parts = [`neo4j=127.0.0.1:${component('neo4j').ports['bolt'] ?? 7687}`];
  const r = capture(ENGINE, ['ps', '-a', '--filter', 'label=d4.tenant', '--format', '{{.Names}} {{index .Labels "d4.bolt-port"}} {{.Ports}}']);
  for (const line of r.out.split('\n')) {
    const [name, label, ...rest] = line.trim().split(/\s+/);
    if (!name) continue;
    // Tenant graphs from before the host network published a port instead of listening on one.
    const port = label && /^\d+$/.test(label) ? label : /:(\d+)->7687\/tcp/.exec(rest.join(' '))?.[1];
    if (port) parts.push(`${name}=127.0.0.1:${port}`);
  }
  return parts.join(',');
}

/** The merged settings of one component on one runtime, as a map (interpolated). */
function componentEnv(comp: Component, rt: Runtime): Record<string, string> {
  const pool = { ...baseEnv() };
  const where = `${comp.rel}/component.yaml`;
  const layer = (l: { common?: Record<string, string>; local?: Record<string, string>; podman?: Record<string, string> }) => ({ ...l.common, ...l[rt] });
  const out: Record<string, string> = comp.sharedEnv ? { ...readEnvFile(join(RUN_DIR, 'env/common.env')) } : {};
  if (comp.sharedEnv) {
    for (const k of ['D4_PUBLIC_URL', 'D4_PUBLIC_API_URL', 'OIDC_ISSUER', 'D4_PORT', 'NPM_REGISTRY']) out[k] = pool[k]!;
    // Images set NODE_EXTRA_CA_CERTS themselves (to the CA baked in at build time).
    if (pool['D4_CA_HOST'] && rt === 'local') out['NODE_EXTRA_CA_CERTS'] = pool['D4_CA_HOST']!;
  }
  // What every dependency provides (addresses, secrets directories), then the component's own env.
  const deps = dependencies(comp);
  for (const dep of deps) for (const [k, v] of Object.entries(layer(dep.provides))) out[k] = interpolate(v, pool, `${dep.rel}/component.yaml provides`);
  if (deps.some((d) => d.name === 'neo4j')) out['NEO4J_HOSTS'] = neo4jHosts();
  Object.assign(pool, out);
  for (const [k, v] of Object.entries(layer(comp.env))) { out[k] = interpolate(v, pool, where); pool[k] = out[k]!; }
  if (comp.sharedEnv) {
    const files = [...(PROFILE === 'prod' ? ['env/prod.env'] : ['env/dev-secrets.env']), 'env/local.env'];
    for (const f of files) Object.assign(out, readEnvFile(join(RUN_DIR, f)));
  }
  for (const k of Object.keys(out)) if (process.env[k] !== undefined && !k.startsWith('PORT_')) out[k] = process.env[k]!;
  return out;
}

/** Writes run/.run/env/<runtime>/<component>.env and returns its path. */
export function writeComponentEnv(comp: Component, rt: Runtime): { file: string; env: Record<string, string> } {
  const env = componentEnv(comp, rt);
  const dir = join(STATE_DIR, 'env', rt);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${comp.name}.env`);
  for (const [k, v] of Object.entries(env)) if (/[\r\n]/.test(v)) throw new RunError(`${comp.name}: ${k} contains a line break, which env files cannot hold`);
  writeFileSync(file, `# Generated by run/run.sh for ${comp.name} on ${rt}; edit run/env/*.env or ${comp.rel}/component.yaml instead.\n` + Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return { file, env };
}
