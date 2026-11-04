// Components: every component.yaml under apps/, packages/ and infra/, checked against the
// contract (run/schema/component.schema.json), and how a selector (`api`, `service`, `stack`,
// `api,worker`) resolves to components in dependency order.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { RunError } from './log.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const RUN_DIR = join(ROOT, 'run');
export const STATE_DIR = join(RUN_DIR, '.run');

export const CATEGORIES = ['ui', 'service', 'infra', 'tool'] as const;
export const RUNTIMES = ['local', 'podman'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Runtime = (typeof RUNTIMES)[number];
export type EnvLayers = { common?: Record<string, string>; local?: Record<string, string>; podman?: Record<string, string> };

export interface PodmanSpec {
  /** Another component's image serves this one in Podman (the web modules: ui-modules). */
  via?: string;
  /** A published image (infra): `${POSTGRES_IMAGE}`. */
  image?: string;
  /** Or built here: the Containerfile in the component folder and what goes into app/. */
  build?: {
    containerfile?: string;
    /** node: `pnpm deploy --prod` of the source; static: its dist/; modules: the dist/ of every
     *  component served `via` this one; files: only `files`; none: the component folder only. */
    artifact: 'node' | 'static' | 'modules' | 'files' | 'none';
    files?: { from: string; to: string }[];
    args?: Record<string, string>;
  };
  entrypoint?: string;
  command?: string[];
  readOnly?: boolean;
  tmpfs?: string[];
  mounts?: { src: string; dst: string; ro?: boolean }[];
  volumes?: { name: string; dst: string }[];
  memory?: string;
  cpus?: number;
  shm?: string;
  restart?: string;
  user?: string;
}

export interface Component {
  name: string;
  category: Category;
  description: string;
  group?: string;
  optional: boolean;
  dependsOn: string[];
  source?: string;
  ports: Record<string, number>;
  health?: { http?: string; port?: number; cmd?: string; timeout: number };
  route?: string;
  provides: EnvLayers;
  env: EnvLayers;
  sharedEnv: boolean;
  runtimes: { default: Runtime; local?: { command: string; build: 'deps' | 'full' }; podman?: PodmanSpec };
  hooks: { postStart: { component: string; args: string[] }[] };
  test: { unit: boolean; integration?: { needs: string[] }; e2e: string[] };
  /** The folder holding component.yaml, absolute and relative to the repository. */
  dir: string;
  rel: string;
}

/** A value from host.conf or run/env/local.env (or the caller's environment). */
function hostSetting(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  let v: string | undefined;
  for (const f of [join(ROOT, 'host.conf'), join(RUN_DIR, 'env/local.env')]) {
    if (!existsSync(f)) continue;
    const m = new RegExp(`^\\s*${key}=(.*)$`, 'm').exec(readFileSync(f, 'utf8'));
    if (m) v = m[1]!.trim();
  }
  return v;
}

const KEYS = new Set(['apiVersion', 'kind', 'name', 'category', 'description', 'group', 'optional', 'dependsOn', 'source', 'ports', 'health', 'route', 'provides', 'env', 'sharedEnv', 'runtimes', 'hooks', 'test']);
const ARTIFACTS = ['node', 'static', 'modules', 'files', 'none'];

function fail(file: string, msg: string): never {
  throw new RunError(`${file}: ${msg}`, { hint: 'see run/schema/component.schema.json for the contract' });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strMap = (file: string, what: string, v: unknown): Record<string, string> => {
  if (v === undefined) return {};
  if (!isObj(v)) fail(file, `${what} must be a map of KEY: value`);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null ? '' : String(x)]));
};
const layers = (file: string, what: string, v: unknown): EnvLayers => {
  if (v === undefined) return {};
  if (!isObj(v)) fail(file, `${what} must have common/local/podman maps`);
  for (const k of Object.keys(v)) if (!['common', 'local', 'podman'].includes(k)) fail(file, `${what}.${k}: expected common, local or podman`);
  return { common: strMap(file, `${what}.common`, v['common']), local: strMap(file, `${what}.local`, v['local']), podman: strMap(file, `${what}.podman`, v['podman']) };
};

/** Parses and checks one component.yaml (the contract, version d4/v1). */
function parseComponent(file: string): Component {
  const rel = relative(ROOT, file);
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(rel, `not valid YAML: ${(e as Error).message}`);
  }
  if (!isObj(doc)) fail(rel, 'expected a map');
  for (const k of Object.keys(doc)) if (!KEYS.has(k)) fail(rel, `unknown key '${k}'`);
  if (doc['apiVersion'] !== 'd4/v1' || doc['kind'] !== 'Component') fail(rel, 'expected apiVersion: d4/v1 and kind: Component');
  const name = doc['name'];
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) fail(rel, 'name must be lower-case letters, digits and dashes');
  const category = doc['category'] as Category;
  if (!CATEGORIES.includes(category)) fail(rel, `category must be one of ${CATEGORIES.join(', ')}`);
  const rt = doc['runtimes'];
  if (!isObj(rt)) fail(rel, 'runtimes is required');
  const def = (rt['default'] ?? (rt['podman'] ? 'podman' : 'local')) as Runtime;
  if (!RUNTIMES.includes(def)) fail(rel, 'runtimes.default must be local or podman');
  if (!rt[def]) fail(rel, `runtimes.default is ${def}, but runtimes.${def} is missing`);
  const local = rt['local'];
  if (local !== undefined && (!isObj(local) || typeof local['command'] !== 'string')) fail(rel, 'runtimes.local.command must be a string');
  if (rt['podman'] !== undefined && !isObj(rt['podman'])) fail(rel, 'runtimes.podman must be a map');
  const podman = rt['podman'] as PodmanSpec | undefined;
  if (podman !== undefined) {
    const ways = [podman.via, podman.image, podman.build].filter((x) => x !== undefined).length;
    if (ways !== 1) fail(rel, 'runtimes.podman needs exactly one of via, image or build');
    if (podman.build && !ARTIFACTS.includes(podman.build.artifact)) fail(rel, `runtimes.podman.build.artifact must be one of ${ARTIFACTS.join(', ')}`);
  }
  const raw = doc['ports'] ?? {};
  if (!isObj(raw)) fail(rel, 'ports must map names to port numbers');
  // A port may come from host.conf (the gateway: `${D4_PORT}`).
  const ports = Object.fromEntries(Object.entries(raw).map(([k, v]) => {
    const n = typeof v === 'string' ? Number(v.replace(/^\$\{(\w+)(?::-(\d+))?\}$/, (_m, key: string, d?: string) => hostSetting(key) ?? d ?? '')) : v;
    if (!Number.isInteger(n)) fail(rel, `ports.${k} must be a port number or \${HOST_CONF_KEY}`);
    return [k, n as number];
  }));
  const health = doc['health'];
  if (health !== undefined && !isObj(health)) fail(rel, 'health must be a map');
  const hooks = isObj(doc['hooks']) ? doc['hooks'] : {};
  const test = isObj(doc['test']) ? doc['test'] : {};
  const integration = test['integration'];
  const list = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(rel, `${what} must be a list of strings`);
    return v as string[];
  };
  return {
    name,
    category,
    description: String(doc['description'] ?? ''),
    ...(typeof doc['group'] === 'string' && { group: doc['group'] }),
    optional: doc['optional'] === true,
    dependsOn: list(doc['dependsOn'], 'dependsOn'),
    ...(typeof doc['source'] === 'string' && { source: doc['source'] }),
    ports: ports as Record<string, number>,
    ...(health && {
      health: {
        ...(typeof health['http'] === 'string' && { http: health['http'] }),
        ...(typeof health['port'] === 'number' && { port: health['port'] }),
        ...(typeof health['cmd'] === 'string' && { cmd: health['cmd'] }),
        timeout: typeof health['timeout'] === 'number' ? health['timeout'] : 120,
      },
    }),
    ...(typeof doc['route'] === 'string' && { route: doc['route'] }),
    provides: layers(rel, 'provides', doc['provides']),
    env: layers(rel, 'env', doc['env']),
    sharedEnv: typeof doc['sharedEnv'] === 'boolean' ? doc['sharedEnv'] : category !== 'infra',
    runtimes: { default: def, ...(local && { local: { command: String(local['command']), build: local['build'] === 'full' ? 'full' : 'deps' } }), ...(podman && { podman }) },
    hooks: {
      postStart: (Array.isArray(hooks['postStart']) ? hooks['postStart'] : []).map((h: unknown) => {
        if (!isObj(h) || typeof h['component'] !== 'string') fail(rel, 'hooks.postStart entries need component and args');
        return { component: h['component'], args: list(h['args'], 'hooks.postStart[].args') };
      }),
    },
    test: {
      unit: test['unit'] !== false && !!doc['source'],
      ...(isObj(integration) && { integration: { needs: list(integration['needs'], 'test.integration.needs') } }),
      e2e: list(test['e2e'], 'test.e2e'),
    },
    dir: dirname(file),
    rel: relative(ROOT, dirname(file)),
  };
}

let cache: Map<string, Component> | undefined;

/** Every component in the repository, checked for consistency across files. */
export function loadComponents(): Map<string, Component> {
  if (cache) return cache;
  const found = new Map<string, Component>();
  for (const top of ['infra', 'apps', 'packages']) {
    const base = join(ROOT, top);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, d.name, 'component.yaml');
      if (!d.isDirectory() || !existsSync(file)) continue;
      const comp = parseComponent(file);
      const dup = found.get(comp.name);
      if (dup) throw new RunError(`component '${comp.name}' is defined twice: ${dup.rel} and ${comp.rel}`);
      found.set(comp.name, comp);
    }
  }
  const seenPorts = new Map<number, string>();
  for (const comp of found.values()) {
    for (const dep of [...comp.dependsOn, ...comp.hooks.postStart.map((h) => h.component), ...(comp.test.integration?.needs ?? [])])
      if (!found.has(dep)) throw new RunError(`${comp.rel}/component.yaml: unknown component '${dep}'`);
    const via = comp.runtimes.podman?.via;
    if (via && !found.has(via)) throw new RunError(`${comp.rel}/component.yaml: runtimes.podman.via names unknown component '${via}'`);
    for (const p of Object.values(comp.ports)) {
      const other = seenPorts.get(p);
      if (other) throw new RunError(`port ${p} is claimed by both ${other} and ${comp.name}: every component needs its own ports on the host network`);
      seenPorts.set(p, comp.name);
    }
  }
  cache = found;
  return found;
}

export function component(name: string): Component {
  const comp = loadComponents().get(name);
  if (!comp) throw new RunError(`unknown component '${name}'`, { hint: 'run/run.sh ls lists the components', code: 2 });
  return comp;
}

/** Components with a long-running process (not tools). */
export const isProcess = (comp: Component) => comp.category !== 'tool';

/**
 * Resolves `api`, `service`, `observability` (a group), `stack` or a comma list to components.
 * `stack` is every non-optional, non-tool component; categories and groups include optional ones.
 */
export function select(selector: string): Component[] {
  const all = [...loadComponents().values()];
  const out = new Map<string, Component>();
  for (const part of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part === 'stack') for (const comp of all) { if (!comp.optional && isProcess(comp)) out.set(comp.name, comp); }
    else if ((CATEGORIES as readonly string[]).includes(part)) for (const comp of all) { if (comp.category === part) out.set(comp.name, comp); }
    else if (all.some((comp) => comp.group === part)) for (const comp of all) { if (comp.group === part) out.set(comp.name, comp); }
    else out.set(part, component(part));
  }
  if (!out.size) throw new RunError(`'${selector}' selects no components`, { code: 2 });
  return order([...out.values()]);
}

/** Dependency order: every component after the ones it depends on (dependsOn, hooks). */
export function order(comps: Component[]): Component[] {
  const want = new Set(comps.map((x) => x.name));
  const done = new Set<string>();
  const out: Component[] = [];
  const visit = (comp: Component, path: string[]) => {
    if (done.has(comp.name)) return;
    if (path.includes(comp.name)) throw new RunError(`dependency cycle: ${[...path, comp.name].join(' → ')}`);
    for (const d of comp.dependsOn) visit(component(d), [...path, comp.name]);
    done.add(comp.name);
    if (want.has(comp.name)) out.push(comp);
  };
  for (const comp of [...comps].sort((a, b) => a.name.localeCompare(b.name))) visit(comp, []);
  return out;
}

/** Every component a component needs, transitively, in dependency order (without itself). */
export function dependencies(comp: Component): Component[] {
  const seen = new Map<string, Component>();
  const walk = (x: Component) => {
    for (const d of x.dependsOn) {
      const dc = component(d);
      if (!seen.has(d)) { seen.set(d, dc); walk(dc); }
    }
  };
  walk(comp);
  return order([...seen.values()]);
}

/** The runtime a command runs a component in: the requested one, or its default; Podman only for infra. */
export function runtimeFor(comp: Component, requested: Runtime | undefined): Runtime {
  const rt = requested ?? comp.runtimes.default;
  if (!comp.runtimes[rt]) {
    const has = RUNTIMES.filter((r) => comp.runtimes[r]).join(' or ');
    throw new RunError(`${comp.name} does not run on ${rt} (it runs on ${has})`, { hint: `use ${has}:${comp.name}:<command>`, code: 2 });
  }
  return rt;
}

/** The container name of a component. */
export const containerName = (name: string) => `d4-${name}`;
/** The first port: what health checks and the gateway use. */
export const mainPort = (comp: Component) => comp.health?.port ?? Object.values(comp.ports)[0];
