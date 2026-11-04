// test: unit (default), integration, static, e2e or smoke for one component or the stack. By
// default only the packages that changed since --base (default HEAD, so uncommitted work) and
// those depending on them, within the component's own packages; --all runs every one of them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { c, capture, elapsed, exec, log, RunError } from './log.ts';
import { component, ROOT, type Component, type Runtime } from './components.ts';
import { baseEnv, ENGINE } from './env.ts';
import { ensureDeps, sourcesOf, toolEnv } from './build.ts';
import { checkHealth, whereRunning } from './runtime.ts';
import { plan, runTool, up } from './lifecycle.ts';
import { gatewayRequest, token } from './extras.ts';

interface Pkg { name: string; dir: string; deps: string[] }

/** Every workspace package with its workspace dependencies. */
function workspace(): Map<string, Pkg> {
  const out = new Map<string, Pkg>();
  for (const top of ['apps', 'packages', 'mocks']) {
    const base = join(ROOT, top);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const file = join(base, d, 'package.json');
      if (!existsSync(file)) continue;
      const pj = JSON.parse(readFileSync(file, 'utf8')) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.entries({ ...pj.dependencies, ...pj.devDependencies }).filter(([, v]) => v.startsWith('workspace:')).map(([k]) => k);
      out.set(pj.name, { name: pj.name, dir: join(top, d), deps });
    }
  }
  return out;
}

function closure(ws: Map<string, Pkg>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const walk = (n: string) => { if (seen.has(n) || !ws.has(n)) return; seen.add(n); ws.get(n)!.deps.forEach(walk); };
  roots.forEach(walk);
  return seen;
}

/** Files changed since `base`, plus uncommitted and untracked ones. */
function changedFiles(base: string): string[] {
  const files = new Set<string>();
  const git = (args: string[]) => {
    const r = capture('git', args, { cwd: ROOT });
    if (r.code !== 0) throw new RunError(`git ${args.join(' ')} failed: ${r.err.trim()}`, { hint: '--base must name a commit, branch or tag' });
    r.out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((f) => files.add(f));
  };
  if (base !== 'HEAD') git(['diff', '--name-only', `${base}...HEAD`]);
  git(['diff', '--name-only', 'HEAD']);
  git(['ls-files', '--others', '--exclude-standard']);
  return [...files];
}

/** The packages to test: in scope, and changed or depending on something changed (or all). */
function selectPackages(scope: Set<string> | undefined, all: boolean, base: string): { pkgs: string[]; why: string } {
  const ws = workspace();
  const inScope = scope ?? new Set(ws.keys());
  if (all) return { pkgs: [...inScope].sort(), why: 'all packages in scope (--all)' };
  const files = changedFiles(base);
  const global = files.filter((f) => !f.includes('/') || /^(tsconfig\.base\.json|eslint\.config\.mjs|pnpm-lock\.yaml|package\.json|turbo\.json|\.node-version)$/.test(f));
  if (global.some((f) => /^(tsconfig\.base\.json|eslint\.config\.mjs|pnpm-lock\.yaml|package\.json|turbo\.json|\.node-version)$/.test(f)))
    return { pkgs: [...inScope].sort(), why: `repository-wide files changed (${global.join(', ')})` };
  const changed = new Set<string>();
  for (const f of files) for (const p of ws.values()) if (f.startsWith(p.dir + '/')) changed.add(p.name);
  const hit = [...inScope].filter((p) => [...closure(ws, [p])].some((d) => changed.has(d))).sort();
  return { pkgs: hit, why: changed.size ? `changed since ${base}: ${[...changed].sort().join(', ')}` : `nothing changed since ${base}` };
}

const SERVICES = ['postgres', 'neo4j', 'redis', 's3'];

/** D4_TEST_* for integration suites: the dev services on the host network. */
function serviceEnv(): Record<string, string> {
  const env = baseEnv();
  return {
    D4_TEST_POSTGRES_URL: `postgres://${env['POSTGRES_USER']}:${env['POSTGRES_PASSWORD']}@127.0.0.1:${env['PORT_POSTGRES']}/postgres`,
    D4_TEST_NEO4J_URL: `bolt://127.0.0.1:${env['PORT_NEO4J_BOLT'] ?? env['PORT_NEO4J']}`,
    D4_TEST_NEO4J_PASSWORD: env['NEO4J_PASSWORD'] ?? '',
    D4_TEST_REDIS_URL: `redis://127.0.0.1:${env['PORT_REDIS']}`,
    D4_TEST_S3_ENDPOINT: `http://127.0.0.1:${env['PORT_S3']}`,
  };
}
const noServices = { D4_TEST_POSTGRES_URL: '', D4_TEST_NEO4J_URL: '', D4_TEST_REDIS_URL: '', D4_TEST_S3_ENDPOINT: '' };

/** turbo on local Node, or in the pinned Node image with the repository mounted (podman). */
async function turbo(rt: Runtime, args: string[], env: Record<string, string>, label: string): Promise<void> {
  await ensureDeps();
  if (rt === 'local') {
    await exec('turbo', args, { cwd: ROOT, env: toolEnv(env), logName: 'test.log', label, inherit: true, hint: 'the failing test output is above; the turbo summary names the failing package' });
    return;
  }
  const image = baseEnv()['NODE_SLIM_IMAGE']!;
  const e = Object.entries({ ...env, TURBO_TELEMETRY_DISABLED: '1', PATH: '/repo/run/.run/tools/node_modules/.bin:/repo/node_modules/.bin:/usr/local/bin:/usr/bin:/bin' }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await exec(ENGINE, ['run', '--rm', '--network', 'host', '-v', `${ROOT}:/repo:z`, '-w', '/repo', '--userns=keep-id', '-e', 'HOME=/tmp', ...e, image, 'turbo', ...args], {
    logName: 'test.log', label, inherit: true, hint: 'the failing test output is above',
  });
}

export async function test(comp: Component | 'stack', rtArg: Runtime | undefined, args: string[]): Promise<void> {
  const suite = ['unit', 'integration', 'static', 'e2e', 'smoke'].find((s) => args.includes(s)) ?? 'unit';
  const all = args.includes('--all');
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] ?? 'HEAD' : 'HEAD';
  const rest = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
  const rt: Runtime = rtArg ?? 'local';
  const name = comp === 'stack' ? 'stack' : comp.name;
  const t = Date.now();

  if (suite === 'e2e') return e2e(comp, rest);
  if (suite === 'smoke') return smoke();

  const ws = workspace();
  const roots = comp === 'stack' ? undefined : sourcesOf(comp);
  if (roots && !roots.length) throw new RunError(`${name} has no packages to ${suite}-test`, { hint: comp !== 'stack' && comp.test.e2e.length ? `try run/run.sh ${name}:test e2e` : undefined });
  const scope = roots ? closure(ws, roots) : undefined;
  const { pkgs, why } = selectPackages(scope, all, base);
  log.phase(`Test ${suite} for ${name} on ${rt}`);
  log.info(why);
  if (!pkgs.length) { log.ok(`nothing to test (run/run.sh ${rtArg ? rtArg + ':' : ''}${name}:test ${suite} --all runs every package in scope)`); return; }
  log.info(`packages: ${pkgs.join(', ')}`);
  const filters = pkgs.map((p) => `--filter=${p}`);
  if (suite === 'static') {
    await turbo(rt, ['run', 'typecheck', 'lint', '--concurrency=2', ...filters, ...rest], noServices, 'typecheck and lint');
    if (comp === 'stack') await exec('pnpm', ['knip'], { cwd: ROOT, env: toolEnv(), logName: 'test.log', label: 'knip', inherit: true });
  } else if (suite === 'integration') {
    const needs = comp === 'stack' ? SERVICES : (comp.test.integration?.needs ?? SERVICES);
    const missing = needs.map((n) => component(n)).filter((n) => !whereRunning(n).length);
    if (missing.length) {
      log.info(`integration tests need ${needs.join(', ')}; starting ${missing.map((x) => x.name).join(', ')} on podman`);
      await up(plan(missing, 'podman', false), { build: false });
    }
    for (const n of needs) {
      const h = await checkHealth(component(n), 'podman');
      if (!h.ok) throw new RunError(`${n} is not healthy (${h.detail})`, { hint: `run/run.sh ${n}:status` });
    }
    await turbo(rt, ['run', 'test', '--concurrency=2', ...filters, ...rest], serviceEnv(), 'integration tests');
  } else {
    await turbo(rt, ['run', 'test', ...filters, ...rest], noServices, 'unit tests');
  }
  log.ok(`${suite} tests passed for ${pkgs.length} package(s) (${elapsed(t)})`);
}

/** e2e: the browser specs mapped to the component (or all) through the gateway, in the Playwright image. */
async function e2e(comp: Component | 'stack', rest: string[]): Promise<void> {
  const env = baseEnv();
  const runner = component('e2e');
  const specs = comp === 'stack' || comp.name === 'e2e' ? [] : comp.test.e2e;
  if (comp !== 'stack' && comp.name !== 'e2e' && !specs.length)
    throw new RunError(`${comp.name} maps no browser specs (test.e2e in ${comp.rel}/component.yaml)`, { hint: 'run/run.sh e2e:test e2e runs them all' });
  log.phase(`Browser tests${specs.length ? `: ${specs.join(' ')}` : ': all specs'} through ${env['D4_PUBLIC_URL']}`);
  const gw = await checkHealth(component('gateway'), 'podman');
  if (!gw.ok) throw new RunError(`the gateway is not healthy (${gw.detail})`, { hint: 'run/run.sh podman:stack:deploy starts the stack' });
  const files = specs.map((s) => s.replace(/^tests\//, ''));
  const extra = rest.some((a) => a.startsWith('--retries')) ? rest : ['--retries=0', ...rest];
  log.detail(`results: ${relative(process.cwd(), join(runner.dir, 'results'))}`);
  await runTool(runner, 'podman', [...files, ...extra], {
    label: 'browser tests',
    env: { E2E_BASE_URL: env['D4_PUBLIC_URL']!, E2E_HOOK_PORT: '3199', E2E_HOOK_URL: 'http://127.0.0.1:3199/d4-hook' },
  });
  log.ok('browser tests passed');
}

/** smoke: gateway and API health, a sign-in and /v1/me through the gateway. */
async function smoke(): Promise<void> {
  log.phase(`Smoke test through ${baseEnv()['D4_PUBLIC_URL']}`);
  for (const path of ['/healthz', '/api/healthz', '/api/readyz']) {
    const r = await gatewayRequest('GET', path);
    if (r.status !== 200) throw new RunError(`GET ${path}: HTTP ${r.status}`, { tail: r.body.split('\n').slice(0, 20) });
    log.ok(`GET ${path}: ${r.status} ${c.dim(r.body.slice(0, 80))}`);
  }
  const me = await gatewayRequest('GET', '/api/v1/me', undefined, await token('dev-admin'));
  if (me.status !== 200) throw new RunError(`GET /api/v1/me: HTTP ${me.status}`, { tail: me.body.split('\n').slice(0, 20) });
  log.ok(`GET /api/v1/me: ${me.status} ${c.dim(me.body.slice(0, 80))}`);
}
