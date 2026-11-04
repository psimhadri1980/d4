// Build once, package when needed: one turbo run compiles every selected package with the shared
// cache; an image is a thin wrapper around that output, tagged with a hash of its inputs, so an
// unchanged component is neither repackaged nor rebuilt.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { c, capture, elapsed, exec, log, opts, RunError } from './log.ts';
import { component, loadComponents, ROOT, RUN_DIR, STATE_DIR, type Component } from './components.ts';
import { baseEnv, ENGINE, interpolate } from './env.ts';

const PNPM_VERSION = /"pnpm@([^"]+)"/.exec(readFileSync(join(ROOT, 'package.json'), 'utf8'))?.[1] ?? '9.12.0';
const TOOLS = join(STATE_DIR, 'tools');

/** PATH with the pinned pnpm (installed once into run/.run/tools) and the workspace binaries. */
export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = baseEnv();
  return {
    ...process.env,
    PATH: [join(TOOLS, 'node_modules/.bin'), join(ROOT, 'node_modules/.bin'), process.env['PATH']].join(':'),
    npm_config_registry: process.env['npm_config_registry'] || env['NPM_REGISTRY'],
    COREPACK_NPM_REGISTRY: process.env['COREPACK_NPM_REGISTRY'] || env['NPM_REGISTRY'],
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    TURBO_TELEMETRY_DISABLED: '1',
    ...(env['D4_CA_HOST'] && !process.env['NODE_EXTRA_CA_CERTS'] && { NODE_EXTRA_CA_CERTS: env['D4_CA_HOST'] }),
    ...extra,
  };
}

let depsReady = false;

/** The pinned pnpm and the workspace's node_modules, installed when missing or out of date. */
export async function ensureDeps(): Promise<void> {
  if (depsReady) return;
  const pnpmBin = join(TOOLS, 'node_modules/.bin/pnpm');
  const have = existsSync(pnpmBin) ? capture(pnpmBin, ['--version']).out.trim() : '';
  if (have !== PNPM_VERSION) {
    log.info(`installing pnpm ${PNPM_VERSION} into run/.run/tools (once)`);
    mkdirSync(TOOLS, { recursive: true });
    await exec('npm', ['install', '--silent', '--no-audit', '--no-fund', '--prefix', TOOLS, `pnpm@${PNPM_VERSION}`], { env: toolEnv(), logName: 'install.log', label: 'installing pnpm' });
  }
  const marker = join(ROOT, 'node_modules/.modules.yaml');
  const stale = !existsSync(marker) || statSync(join(ROOT, 'pnpm-lock.yaml')).mtimeMs > statSync(marker).mtimeMs;
  if (stale) {
    const t = Date.now();
    log.info(existsSync(marker) ? 'pnpm-lock.yaml changed: installing dependencies' : 'no node_modules yet: installing dependencies');
    await exec('pnpm', ['install', '--frozen-lockfile'], {
      cwd: ROOT, env: toolEnv(), logName: 'install.log', label: 'pnpm install',
      hint: 'after a package.json change, run `pnpm install` to update pnpm-lock.yaml and commit it',
    });
    log.ok(`dependencies installed (${elapsed(t)})`);
  }
  depsReady = true;
}

/** The workspace packages a component compiles: its source, or those of the modules it serves. */
export function sourcesOf(comp: Component): string[] {
  if (comp.runtimes.podman?.build?.artifact === 'modules')
    return [...loadComponents().values()].filter((x) => x.runtimes.podman?.via === comp.name && x.source).map((x) => x.source!);
  return comp.source ? [comp.source] : [];
}

/**
 * Compiles the packages with one turbo run (dependencies first, cached), printing each task as
 * it hits the cache or builds. Type errors surface here, before anything is packaged or stopped.
 */
export async function compile(packages: string[]): Promise<void> {
  const pkgs = [...new Set(packages)];
  if (!pkgs.length) return;
  await ensureDeps();
  const t = Date.now();
  let hits = 0;
  let built = 0;
  log.info(`compiling ${pkgs.join(', ')} and their workspace dependencies (turbo, shared cache)`);
  await exec('turbo', ['run', 'build', '--output-logs=new-only', ...pkgs.map((p) => `--filter=${p}...`)], {
    cwd: ROOT, env: toolEnv(), logName: 'build.log', label: 'turbo build',
    hint: 'the compiler errors are above; fix them and run the command again',
    onLine: (l) => {
      const m = /^(@?[\w/.-]+):build: cache (hit|miss|bypass)/.exec(l);
      if (m) {
        if (m[2] === 'hit') { hits++; if (opts.verbose) log.detail(`${m[1]} ${c.green('cached')}`); }
        else { built++; log.detail(`${m[1]} ${c.yellow('building')}`); }
      } else if (/error|ERR_|ERROR/.test(l) && !/^\s*•/.test(l)) log.error(l.slice(0, 200));
    },
  });
  log.ok(`compiled: ${built} built, ${hits} from cache (${elapsed(t)})`);
}

let hashes: Map<string, string> | undefined;

/** turbo's hash of each package's build task (covers its sources and its dependencies' hashes). */
function turboHashes(packages: string[]): Map<string, string> {
  hashes ??= new Map();
  const missing = packages.filter((p) => !hashes!.has(p));
  if (missing.length) {
    const r = capture(join(ROOT, 'node_modules/.bin/turbo'), ['run', 'build', '--dry=json', ...missing.map((p) => `--filter=${p}`)], { cwd: ROOT, env: toolEnv() });
    if (r.code !== 0) throw new RunError(`turbo could not hash ${missing.join(', ')}`, { tail: (r.err || r.out).split('\n').slice(-20) });
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'))) as { tasks: { taskId: string; hash: string }[] };
    for (const task of json.tasks) if (task.taskId.endsWith('#build')) hashes.set(task.taskId.slice(0, -'#build'.length), task.hash);
  }
  return hashes;
}

/** Hashes many packages with one turbo call (status). */
export const prefetchHashes = (packages: string[]) => void turboHashes([...new Set(packages)]);

const SKIP = new Set(['node_modules', 'dist', 'results', '.auth', '.turbo', 'coverage']);
const SOURCE_SKIP = new Set(['src', 'test', 'tests', 'public', 'index.html']);

/** The component folder's own files: what component/ in the build context holds. */
function componentFiles(comp: Component): string[] {
  const out: string[] = [];
  const walk = (dir: string, top: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || (top && comp.source && SOURCE_SKIP.has(e.name))) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(comp.dir, true);
  return out.sort();
}

function hashFile(h: ReturnType<typeof createHash>, file: string): void {
  h.update(relative(ROOT, file) + '\0');
  h.update(readFileSync(file));
}

function filesUnder(p: string): string[] {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}

/** The build args an image gets: the pinned base images, the registry and the organization CA. */
function buildArgs(comp: Component): Record<string, string> {
  const env = baseEnv();
  const args: Record<string, string> = {
    NODE_IMAGE: env['NODE_IMAGE'] ?? '', NODE_SLIM_IMAGE: env['NODE_SLIM_IMAGE'] ?? '', NGINX_IMAGE: env['NGINX_IMAGE'] ?? '',
    PLAYWRIGHT_IMAGE: env['PLAYWRIGHT_IMAGE'] ?? '', NPM_REGISTRY: env['NPM_REGISTRY'] ?? '', NODE_EXTRA_CA_CERTS: env['D4_CA_BUILD'] ?? '',
  };
  for (const [k, v] of Object.entries(comp.runtimes.podman?.build?.args ?? {})) args[k] = interpolate(v, env, `${comp.rel}/component.yaml`);
  return args;
}

/** A hash of everything an image is made from: tag `localhost/d4-<name>:<hash>`. */
export function imageHash(comp: Component): string {
  const build = comp.runtimes.podman?.build;
  if (!build) throw new RunError(`${comp.name} has no image to build`);
  const h = createHash('sha256');
  const srcs = sourcesOf(comp);
  const th = turboHashes(srcs);
  for (const s of srcs.sort()) h.update(`${s}=${th.get(s) ?? 'unknown'}\n`);
  for (const f of componentFiles(comp)) hashFile(h, f);
  for (const f of build.files ?? []) for (const file of filesUnder(join(ROOT, f.from))) hashFile(h, file);
  const ca = join(RUN_DIR, 'certs/org-ca.crt');
  if (existsSync(ca)) hashFile(h, ca);
  h.update(JSON.stringify(buildArgs(comp)));
  return h.digest('hex').slice(0, 12);
}

export const imageRef = (comp: Component, hash: string) => `localhost/d4-${comp.name}:${hash}`;
export const imageExists = (ref: string) => capture(ENGINE, ['image', 'exists', ref]).code === 0;

/**
 * Stages the build context: component/ (the folder), certs/ (the organization CA only), app/
 * and, for node artifacts, deps/ (node_modules apart, so a code-only change reuses that layer).
 */
async function stage(comp: Component, ctx: string): Promise<void> {
  const build = comp.runtimes.podman!.build!;
  rmSync(ctx, { recursive: true, force: true });
  mkdirSync(join(ctx, 'app'), { recursive: true });
  mkdirSync(join(ctx, 'component'), { recursive: true });
  for (const f of componentFiles(comp)) cpSync(f, join(ctx, 'component', relative(comp.dir, f)));
  mkdirSync(join(ctx, 'certs'), { recursive: true });
  mkdirSync(join(ctx, 'deps'), { recursive: true });
  if (existsSync(join(RUN_DIR, 'certs/org-ca.crt'))) cpSync(join(RUN_DIR, 'certs/org-ca.crt'), join(ctx, 'certs/org-ca.crt'));
  const app = join(ctx, 'app');
  if (build.artifact === 'node') {
    log.detail(`packaging ${comp.source} with its production dependencies (pnpm deploy)`);
    rmSync(app, { recursive: true, force: true });
    await exec('pnpm', ['--filter', comp.source!, 'deploy', '--prod', '--prefer-offline', app], {
      cwd: ROOT, env: toolEnv(), logName: `${comp.name}.package.log`, label: `packaging ${comp.name}`, quiet: !process.env['D4_DEBUG'],
    });
    for (const extra of ['src', 'test', 'Containerfile', 'component.yaml', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts'])
      rmSync(join(app, extra), { recursive: true, force: true });
    if (!existsSync(join(app, 'dist'))) throw new RunError(`${comp.name}: the packaged app has no dist/ (did the build of ${comp.source} write one?)`);
    if (existsSync(join(app, 'node_modules'))) stableDeps(comp, join(app, 'node_modules'), join(ctx, 'deps', 'node_modules'));
  } else if (build.artifact === 'static') {
    const dist = join(comp.dir, 'dist');
    if (!existsSync(dist)) throw new RunError(`${comp.name}: ${relative(ROOT, dist)} is missing after the build`);
    cpSync(dist, app, { recursive: true });
  } else if (build.artifact === 'modules') {
    for (const mod of [...loadComponents().values()].filter((x) => x.runtimes.podman?.via === comp.name)) {
      const dist = join(mod.dir, 'dist');
      if (!existsSync(dist)) throw new RunError(`${comp.name}: ${relative(ROOT, dist)} is missing after the build`);
      cpSync(dist, join(app, mod.name.replace(/^web-/, '')), { recursive: true });
    }
  }
  for (const f of build.files ?? []) cpSync(join(ROOT, f.from), join(app, f.to), { recursive: true });
}

/**
 * A fingerprint of a packaged node_modules: third-party packages live under versioned paths
 * (`.pnpm/<name>@<version>/`), so their path and size suffice; the workspace's own packages
 * (`@d4+…`) and everything else are hashed by content. pnpm's state file (timestamps) is skipped.
 */
function depsKey(dir: string): string {
  const h = createHash('sha1');
  // Symlinks are hashed as links, never followed (pnpm links every package several times).
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (rel === '.modules.yaml') continue;
      h.update(rel + '\0');
      if (e.isSymbolicLink()) h.update('-> ' + readlinkSync(p));
      else if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(rel.startsWith('.pnpm/') && !rel.includes('@d4+') ? String(lstatSync(p).size) : readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/**
 * Keeps a component's packaged node_modules in run/.run/deps/<name>, replaced only when its
 * content changes, and hard-links it into the build context: unchanged dependencies keep their
 * timestamps, so Podman reuses the dependency layer and a code-only change copies just dist/.
 */
function stableDeps(comp: Component, fresh: string, into: string): void {
  const keep = join(STATE_DIR, 'deps', comp.name);
  const key = depsKey(fresh);
  const keyFile = join(STATE_DIR, 'deps', `${comp.name}.key`);
  if (existsSync(keyFile) && existsSync(keep) && readFileSync(keyFile, 'utf8') === key) {
    rmSync(fresh, { recursive: true, force: true });
    log.detail('dependencies unchanged: reusing their image layer');
  } else {
    rmSync(keep, { recursive: true, force: true });
    mkdirSync(join(STATE_DIR, 'deps'), { recursive: true });
    renameSync(fresh, keep);
    writeFileSync(keyFile, key);
    log.detail('dependencies changed: a new dependency layer');
  }
  const r = capture('cp', ['-al', keep, into]);
  if (r.code !== 0) throw new RunError(`${comp.name}: could not link its dependencies into the build context: ${r.err.trim()}`);
}

/** Builds a component's image unless one with the same input hash exists; returns its reference. */
async function buildImage(comp: Component, i: number, n: number): Promise<string> {
  const t = Date.now();
  const hash = imageHash(comp);
  const ref = imageRef(comp, hash);
  if (imageExists(ref)) {
    log.step(i, n, comp.name, `image ${c.dim(ref)} ${c.green('up to date')}`);
    return ref;
  }
  log.step(i, n, comp.name, `image ${c.dim(ref)} ${c.yellow('building')} (inputs changed)`);
  // Usually compiled already by the batch before; turbo replays its cache then.
  await compile(sourcesOf(comp));
  const ctx = join(STATE_DIR, 'ctx', comp.name);
  await stage(comp, ctx);
  const containerfile = join(ctx, 'component', comp.runtimes.podman!.build!.containerfile ?? 'Containerfile');
  if (!existsSync(containerfile)) throw new RunError(`${comp.name}: no ${relative(ROOT, join(comp.dir, comp.runtimes.podman!.build!.containerfile ?? 'Containerfile'))}`);
  const args = Object.entries(buildArgs(comp)).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
  await exec(ENGINE, ['build', '-f', containerfile, '-t', ref, '--label', `d4.component=${comp.name}`, '--label', `d4.hash=${hash}`, ...args, ctx], {
    env: toolEnv(), logName: `${comp.name}.image.log`, label: `building the ${comp.name} image`,
    hint: `the Containerfile is ${relative(ROOT, join(comp.dir, comp.runtimes.podman!.build!.containerfile ?? 'Containerfile'))}`,
    onLine: (l) => { if (/^STEP \d+\/\d+/.test(l)) log.detail(l.slice(0, 140)); },
  });
  rmSync(ctx, { recursive: true, force: true });
  pruneImages(comp, ref);
  log.ok(`${comp.name}: built ${ref} (${elapsed(t)})`);
  return ref;
}

/** Removes older tags of a component's image that no container uses. */
function pruneImages(comp: Component, keep: string): void {
  const r = capture(ENGINE, ['images', '--filter', `reference=localhost/d4-${comp.name}`, '--format', '{{.Repository}}:{{.Tag}}']);
  const used = new Set(capture(ENGINE, ['ps', '-a', '--format', '{{.Image}}']).out.split('\n').map((s) => s.trim()));
  for (const ref of r.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (ref === keep || used.has(ref) || ref.endsWith(':<none>')) continue;
    if (capture(ENGINE, ['rmi', ref]).code === 0) log.detail(`removed old image ${ref}`);
  }
}

/** The image a component runs in Podman: built, its via component's, or a published one (pulled). */
export async function ensureImage(comp: Component, i: number, n: number): Promise<string> {
  const spec = comp.runtimes.podman!;
  if (spec.build) return buildImage(comp, i, n);
  if (spec.via) return ensureImage(component(spec.via), i, n);
  const ref = interpolate(spec.image!, baseEnv(), `${comp.rel}/component.yaml`);
  if (!ref) throw new RunError(`${comp.name}: runtimes.podman.image is empty (is it pinned in run/env/images.env?)`);
  if (imageExists(ref)) {
    log.step(i, n, comp.name, `image ${c.dim(ref)} ${c.green('present')}`);
  } else {
    log.step(i, n, comp.name, `image ${c.dim(ref)} ${c.yellow('pulling')}`);
    await exec(ENGINE, ['pull', ref], { logName: `${comp.name}.image.log`, label: `pulling ${ref}`, hint: 'check the registry, proxy and NPM_REGISTRY/ORG_CA_FILE settings' });
  }
  return ref;
}
