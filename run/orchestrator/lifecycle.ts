// The lifecycle commands: build, deploy, start, stop, reset, status, logs, exec and shell. A
// component runs in one runtime at a time: starting it on one stops it on the other first. The
// gateway (always Podman) reaches it at the same 127.0.0.1:<port> either way.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { c, capture, elapsed, exec, log, opts, RunError } from './log.ts';
import { component, containerName, dependencies, isProcess, mainPort, order, ROOT, runtimeFor, STATE_DIR, type Component, type Runtime } from './components.ts';
import { baseEnv, ENGINE, writeComponentEnv } from './env.ts';
import { compile, ensureDeps, ensureImage, imageExists, imageHash, imageRef, prefetchHashes, sourcesOf } from './build.ts';
import {
  checkHealth, containers, describeRuntime, legacyContainers, localInfo, localLog, localPid, localStart, localStop, podmanStart, podmanStop, waitHealthy, whereRunning,
} from './runtime.ts';

interface Target { comp: Component; rt: Runtime }

/**
 * The runtime of each selected component. An explicit runtime applies to every component that
 * supports it; the others (infra on `local`) use their default, which is said once.
 */
export function plan(comps: Component[], rt: Runtime | undefined, strict: boolean): Target[] {
  const out: Target[] = [];
  const fallback: string[] = [];
  for (const comp of comps) {
    if (strict || !rt || comp.runtimes[rt]) out.push({ comp, rt: runtimeFor(comp, rt) });
    else { out.push({ comp, rt: comp.runtimes.default }); fallback.push(comp.name); }
  }
  if (fallback.length) log.info(`${fallback.join(', ')} ${fallback.length > 1 ? 'have' : 'has'} no ${rt} runtime: using ${c.blue('podman')}`);
  return out;
}

/** The packages to compile for targets: local runs need their dependencies (or all, `full`), images their sources. */
function compileList(targets: Target[]): string[] {
  const out: string[] = [];
  for (const { comp, rt } of targets) {
    if (rt === 'local' && comp.source) out.push(comp.runtimes.local?.build === 'full' || !isProcess(comp) ? comp.source : `${comp.source}^`);
    if (rt === 'podman') {
      const via = comp.runtimes.podman?.via ? component(comp.runtimes.podman.via) : comp;
      if (via.runtimes.podman?.build) out.push(...sourcesOf(via));
    }
  }
  return out;
}

/** build: compile (local) and package images (podman) for the targets, only what changed. */
export async function build(targets: Target[]): Promise<Map<string, string>> {
  const t = Date.now();
  const images = new Map<string, string>();
  // `pkg^` compiles only the dependencies (turbo `pkg^...`): local dev servers compile the package themselves.
  const pkgs = compileList(targets);
  log.phase(`Build: ${targets.map((x) => `${x.comp.name} (${x.rt})`).join(', ')}`);
  if (pkgs.length) await compile(pkgs);
  else log.info('nothing to compile');
  const pod = targets.filter((x) => x.rt === 'podman');
  const unique = order([...new Map(pod.map((x) => {
    const via = x.comp.runtimes.podman?.via;
    const comp = via ? component(via) : x.comp;
    return [comp.name, comp];
  })).values()]);
  if (unique.length) {
    if (unique.some((x) => x.runtimes.podman?.build)) await ensureDeps();
    log.phase(`Images: ${unique.length}`);
    let i = 0;
    for (const comp of unique) images.set(comp.name, await ensureImage(comp, ++i, unique.length));
  }
  log.ok(`build finished (${elapsed(t)})`);
  return images;
}

/** Makes sure the gateway and every dependency of the targets run (started, not rebuilt). */
function withDependencies(targets: Target[]): { targets: Target[]; added: string[] } {
  const named = new Set(targets.map((x) => x.comp.name));
  const cons = containers();
  const extra: Target[] = [];
  const need = new Map<string, Component>();
  // A module on podman runs in its via component's container: that one is restarted even when it
  // runs, so it picks up the image just built (podmanStart leaves it alone when nothing changed).
  const servers = new Map<string, Component>();
  for (const { comp, rt } of targets) {
    if (!isProcess(comp)) continue;
    for (const d of dependencies(comp)) need.set(d.name, d);
    if (comp.name !== 'gateway' && comp.category !== 'infra') need.set('gateway', component('gateway'));
    const via = comp.runtimes.podman?.via;
    if (via) (rt === 'podman' ? servers : need).set(via, component(via));
  }
  for (const d of servers.values()) {
    need.delete(d.name);
    if (!named.has(d.name)) extra.push({ comp: d, rt: 'podman' });
  }
  for (const d of need.values()) {
    if (named.has(d.name) || whereRunning(d, cons).length) continue;
    extra.push({ comp: d, rt: d.runtimes.default });
  }
  const byName = new Map([...extra, ...targets].map((x) => [x.comp.name, x]));
  return { targets: order([...byName.values()].map((x) => x.comp)).map((x) => byName.get(x.name)!), added: extra.map((x) => x.comp.name) };
}

const hookState = (name: string) => join(STATE_DIR, 'hooks', `${name}.json`);

/**
 * postStart hooks (migrations and seed after postgres, the graph schema after neo4j): run when the
 * component was (re)started or the hook's image changed since they last ran.
 */
async function runHooks(comp: Component, restarted: boolean): Promise<void> {
  for (const hook of comp.hooks.postStart) {
    const tool = component(hook.component);
    const ref = await ensureImage(tool, 1, 1);
    const key = `${ref} ${hook.args.join(' ')}`;
    const last = existsSync(hookState(comp.name)) ? (JSON.parse(readFileSync(hookState(comp.name), 'utf8')) as Record<string, string>) : {};
    if (!restarted && last[hook.args.join(' ')] === key) { log.detail(`hook ${hook.component} ${hook.args.join(' ')}: already ran with this image`); continue; }
    const t = Date.now();
    log.info(`hook: ${hook.component} ${hook.args.join(' ')} (after ${comp.name} started)`);
    await runTool(tool, 'podman', hook.args, { logName: `${comp.name}.hooks.log`, label: `${hook.component} ${hook.args.join(' ')}` });
    last[hook.args.join(' ')] = key;
    mkdirSync(join(STATE_DIR, 'hooks'), { recursive: true });
    writeFileSync(hookState(comp.name), JSON.stringify(last));
    log.ok(`hook ${hook.component} ${hook.args.join(' ')} done (${elapsed(t)})`);
  }
}

/** Stops a component wherever it runs other than `rt`, so it never runs twice. */
async function switchFrom(comp: Component, rt: Runtime): Promise<void> {
  for (const other of whereRunning(comp)) {
    if (other === rt) continue;
    log.info(`${comp.name} is running on ${describeRuntime(other)}: stopping it there before starting it on ${describeRuntime(rt)}`);
    if (other === 'podman') await podmanStop(comp); else await localStop(comp);
  }
}

/** Removes the containers of the old compose setup (volumes kept), which hold the same ports. */
async function removeLegacy(): Promise<void> {
  const old = legacyContainers();
  if (!old.length) { removeOldNetwork(); return; }
  log.phase(`Removing ${old.length} containers from the old compose setup (their volumes and data are kept)`);
  // Podman can report a failed network clean-up after removing them; what counts is what is left.
  const r = await exec(ENGINE, ['rm', '-f', '-t', '10', ...old], { logName: 'legacy.log', label: 'removing old containers', okCodes: [0, 125] });
  const left = legacyContainers();
  if (left.length) throw new RunError(`could not remove old containers: ${left.join(', ')}`, { tail: r.tail, hint: `remove them yourself: ${ENGINE} rm -f ${left.join(' ')}` });
  if (r.code) log.warn(`podman reported: ${r.tail.at(-1) ?? 'an error'} (the containers are gone)`);
  log.ok(`removed ${old.length} old containers`);
  removeOldNetwork();
}

/** The old compose network `d4`: nothing uses networks any more (everything is on the host network). */
function removeOldNetwork(): void {
  if (capture(ENGINE, ['network', 'exists', 'd4']).code !== 0) return;
  const users = capture(ENGINE, ['ps', '-a', '--filter', 'network=d4', '--format', '{{.Names}}']).out.trim();
  if (users) { log.warn(`the old d4 network is still used by: ${users.replace(/\n/g, ', ')} (tenant graphs: recreate them with run/run.sh ops:exec -- tenant create)`); return; }
  const r = capture(ENGINE, ['network', 'rm', 'd4']);
  if (r.code === 0) log.ok('removed the old d4 network'); else log.warn(`could not remove the old d4 network: ${r.err.trim()}`);
}

/** deploy / start: build (deploy only, or when nothing is built yet), switch runtime, start, wait, hooks. */
export async function up(targets: Target[], o: { build: boolean }): Promise<void> {
  const t = Date.now();
  const procs = targets.filter((x) => isProcess(x.comp));
  const { targets: all, added } = withDependencies(procs);
  if (added.length) log.info(`also starting what they need (not running, or serving them on podman): ${added.join(', ')}`);
  // Built first: a broken change fails here and leaves everything running as it was.
  let images = new Map<string, string>();
  const toBuild = o.build ? [...all, ...targets.filter((x) => !isProcess(x.comp))] : all.filter((x) => needsBuild(x));
  if (toBuild.length) images = await build(dedupe(toBuild));
  if (all.some((x) => x.rt === 'podman')) await removeLegacy();
  log.phase(`Start: ${all.map((x) => `${x.comp.name} (${x.rt})`).join(' → ')}`);
  let i = 0;
  for (const { comp, rt } of all) {
    log.step(++i, all.length, comp.name, `${o.build ? 'deploy' : 'start'} on ${describeRuntime(rt)}`);
    await switchFrom(comp, rt);
    let result: string;
    if (rt === 'podman') {
      const via = comp.runtimes.podman?.via;
      if (via) { log.info(`${comp.name} is served by ${via} on podman`); continue; }
      const image = images.get(comp.name) ?? (await currentImage(comp));
      result = await podmanStart(comp, image, false);
    } else {
      result = await localStart(comp);
    }
    await waitHealthy(comp, rt);
    if (comp.hooks.postStart.length) await runHooks(comp, result !== 'unchanged');
  }
  log.ok(`done in ${elapsed(t)}: ${all.map((x) => x.comp.name).join(', ')}`);
  for (const { comp, rt } of all) if (comp.route) log.detail(`${comp.name} (${rt}) → ${baseEnv()['D4_PUBLIC_URL']}${comp.route}`);
}

const dedupe = (ts: Target[]) => [...new Map(ts.map((x) => [`${x.comp.name}:${x.rt}`, x])).values()];

/** start: only build what has never been built (no image yet, no dist/ yet). */
function needsBuild({ comp, rt }: Target): boolean {
  if (rt === 'local') return !!comp.source && !existsSync(join(comp.dir, 'dist'));
  const via = comp.runtimes.podman?.via ? component(comp.runtimes.podman.via) : comp;
  if (!via.runtimes.podman?.build) return false;
  return !latestImage(via);
}

function latestImage(comp: Component): string | undefined {
  const r = capture(ENGINE, ['images', '--filter', `reference=localhost/d4-${comp.name}`, '--sort', 'created', '--format', '{{.Repository}}:{{.Tag}}']);
  return r.out.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith(':<none>'))[0];
}

/** start without build: the image built last (or the published one). */
async function currentImage(comp: Component): Promise<string> {
  if (!comp.runtimes.podman?.build) return ensureImage(comp, 1, 1);
  const img = latestImage(comp);
  if (!img) throw new RunError(`${comp.name} has no image yet`, { hint: `run/run.sh podman:${comp.name}:deploy builds it` });
  return img;
}

/** stop: in reverse dependency order, wherever each component runs (or only on `rt`). */
export async function stop(targets: Target[], rt: Runtime | undefined): Promise<void> {
  const procs = targets.filter((x) => isProcess(x.comp)).reverse();
  log.phase(`Stop: ${procs.map((x) => x.comp.name).join(', ')}`);
  let i = 0;
  for (const { comp } of procs) {
    const where = whereRunning(comp).filter((w) => !rt || w === rt);
    log.step(++i, procs.length, comp.name, where.length ? `stopping on ${where.map(describeRuntime).join(' and ')}` : c.dim('not running'));
    for (const w of where) {
      if (w === 'podman') await podmanStop(comp); else await localStop(comp);
      log.ok(`${comp.name} stopped on ${w}`);
    }
  }
}

async function confirm(question: string): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new RunError(`${question}: pass --yes to confirm when not running in a terminal`, { code: 2 });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = await rl.question(`${c.yellow('?')} ${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

/** reset: stop, then remove containers and their volumes (podman) or build output (local). */
export async function reset(targets: Target[], rt: Runtime | undefined, wholeStack: boolean): Promise<void> {
  const vols = targets.flatMap((x) => x.comp.runtimes.podman?.volumes?.map((v) => v.name) ?? []);
  const what = [
    `${targets.length} component(s): ${targets.map((x) => x.comp.name).join(', ')}`,
    vols.length && (!rt || rt === 'podman') ? `volumes (data is deleted): ${vols.join(', ')}` : '',
    wholeStack ? 'all D4 images and run/.run state' : '',
  ].filter(Boolean);
  log.phase('Reset');
  for (const w of what) log.info(w);
  if (!(await confirm('Reset these?'))) throw new RunError('reset cancelled', { code: 1 });
  for (const { comp } of [...targets].reverse()) {
    if (!rt || rt === 'podman') {
      if (await podmanStop(comp, true)) log.ok(`${containerName(comp.name)} removed`);
      for (const v of comp.runtimes.podman?.volumes ?? [])
        if (capture(ENGINE, ['volume', 'exists', v.name]).code === 0) { await exec(ENGINE, ['volume', 'rm', '-f', v.name], { logName: 'reset.log', label: `removing volume ${v.name}` }); log.ok(`volume ${v.name} removed`); }
      rmSync(join(STATE_DIR, 'hooks', `${comp.name}.json`), { force: true });
    }
    if (!rt || rt === 'local') {
      if (await localStop(comp)) log.ok(`${comp.name} stopped on local`);
      if (comp.source) { rmSync(join(comp.dir, 'dist'), { recursive: true, force: true }); log.ok(`${comp.rel}/dist removed`); }
      rmSync(localLog(comp.name), { force: true });
    }
  }
  if (wholeStack) {
    await removeLegacy();
    const imgs = capture(ENGINE, ['images', '--filter', 'reference=localhost/d4-*', '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').filter((s) => s.trim() && !s.endsWith(':<none>'));
    if (imgs.length) await exec(ENGINE, ['rmi', '-f', ...imgs], { logName: 'reset.log', label: 'removing D4 images', okCodes: [0, 1, 2] });
    for (const d of ['env', 'ctx', 'pids', 'hooks']) rmSync(join(STATE_DIR, d), { recursive: true, force: true });
    log.ok('images and run/.run state removed');
  }
}

/** logs: follows (or prints the tail of) a component's output wherever it runs. */
export async function logs(targets: Target[], rt: Runtime | undefined, args: string[]): Promise<void> {
  const follow = !args.includes('--no-follow') && targets.length === 1;
  const n = args[args.indexOf('-n') + 1] && args.includes('-n') ? args[args.indexOf('-n') + 1]! : '100';
  for (const { comp } of targets) {
    const where = rt ? [rt] : whereRunning(comp);
    const at = where[0] ?? (localInfo(comp.name) ? 'local' : 'podman');
    log.phase(`${comp.name} logs (${at})${follow ? ', following: Ctrl-C to stop' : ''}`);
    if (at === 'podman') {
      const name = containerName(comp.runtimes.podman?.via ?? comp.name);
      if (!containers().has(comp.runtimes.podman?.via ?? comp.name)) { log.warn(`${name} does not exist`); continue; }
      await exec(ENGINE, ['logs', '--tail', n, ...(follow ? ['-f'] : []), name], { inherit: true, okCodes: [0, 1, 130, 143] });
    } else {
      const file = localLog(comp.name);
      if (!existsSync(file)) { log.warn(`no local log for ${comp.name} yet (${file})`); continue; }
      await exec('tail', ['-n', n, ...(follow ? ['-F'] : []), file], { inherit: true, okCodes: [0, 1, 130, 143] });
    }
  }
}

/** Runs a tool once (ops, cli, e2e): `podman run --rm` on the host network, or its local command. */
export async function runTool(comp: Component, rt: Runtime, args: string[], o: { logName?: string; label?: string; inherit?: boolean; env?: Record<string, string> } = {}): Promise<void> {
  if (rt === 'local') {
    const { env } = writeComponentEnv(comp, 'local');
    const cmd = comp.runtimes.local!.command;
    await exec('bash', ['-c', `${cmd} "$@"`, comp.name, ...args], { cwd: ROOT, env: { ...process.env, ...env, ...o.env }, ...(o.logName && { logName: o.logName }), label: o.label ?? `${comp.name} ${args.join(' ')}`, inherit: o.inherit ?? !o.logName });
    return;
  }
  const spec = comp.runtimes.podman!;
  const image = imageExists(imageRef(comp, imageHash(comp))) ? imageRef(comp, imageHash(comp)) : await ensureImage(comp, 1, 1);
  const { file } = writeComponentEnv(comp, 'podman');
  // `-e KEY` takes the value from this process, so secrets (tokens) never appear in the logged command.
  const extra = Object.keys(o.env ?? {}).flatMap((k) => ['-e', k]);
  const mounts = (spec.mounts ?? []).flatMap((m) => {
    if (!existsSync(join(ROOT, m.src))) mkdirSync(join(ROOT, m.src), { recursive: true });
    return ['-v', `${join(ROOT, m.src)}:${m.dst}:${m.ro ? 'ro,' : ''}z`];
  });
  const tty = (o.inherit ?? !o.logName) && process.stdin.isTTY ? ['-it'] : [];
  await exec(ENGINE, ['run', '--rm', ...tty, '--network', 'host', '--env-file', file, ...extra, ...mounts,
    ...(spec.shm ? ['--shm-size', spec.shm] : []), ...(spec.user ? ['--user', spec.user] : []), image, ...(spec.command ?? []), ...args], {
    ...(o.logName && { logName: o.logName }), label: o.label ?? `${comp.name} ${args.join(' ')}`, inherit: o.inherit ?? !o.logName,
    env: { ...process.env, ...o.env },
  });
}

/** Before a tool runs (ops, cli): starts what it depends on that is not running (no build). */
export async function ensureDependencies(comp: Component): Promise<void> {
  const missing = dependencies(comp).filter((d) => isProcess(d) && !whereRunning(d).length);
  if (!missing.length) return;
  log.info(`${comp.name} needs ${missing.map((d) => d.name).join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not running: starting ${missing.length > 1 ? 'them' : 'it'}`);
  await up(plan(missing, undefined, false), { build: false });
}

/** exec: a tool once, or a command inside a running component (its container, or its env locally). */
export async function execIn(comp: Component, rt: Runtime | undefined, args: string[]): Promise<void> {
  if (!isProcess(comp)) return runTool(comp, runtimeFor(comp, rt), args);
  if (!args.length) throw new RunError(`usage: run.sh ${comp.name}:exec -- <command> [args]`, { code: 2 });
  const where = rt ?? whereRunning(comp)[0] ?? comp.runtimes.default;
  if (where === 'podman') {
    if (containers().get(comp.name)?.state !== 'running') throw new RunError(`${comp.name} is not running on podman`, { hint: `run/run.sh podman:${comp.name}:start` });
    await exec(ENGINE, ['exec', ...(process.stdin.isTTY ? ['-it'] : []), containerName(comp.name), ...args], { inherit: true });
  } else {
    const { env } = writeComponentEnv(comp, 'local');
    await exec(args[0]!, args.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, inherit: true });
  }
}

/** shell: a shell in the container, or on the host with the component's settings loaded. */
export async function shell(comp: Component, rt: Runtime | undefined): Promise<void> {
  const where = rt ?? whereRunning(comp)[0] ?? comp.runtimes.default;
  if (where === 'podman') {
    if (containers().get(comp.name)?.state !== 'running') throw new RunError(`${comp.name} is not running on podman`);
    await exec(ENGINE, ['exec', '-it', containerName(comp.name), 'sh'], { inherit: true, okCodes: [0, 1, 130] });
  } else {
    const { env } = writeComponentEnv(comp, 'local');
    log.info(`a shell with ${comp.name}'s local settings; exit to leave`);
    await exec(process.env['SHELL'] || 'bash', [], { cwd: ROOT, env: { ...process.env, ...env }, inherit: true, okCodes: [0, 1, 130] });
  }
}

/** status: one row per component: where it runs, its state and health, its route and build. */
export async function status(comps: Component[], rt: Runtime | undefined, json: boolean): Promise<number> {
  const cons = containers();
  const env = baseEnv();
  let stalePossible = existsSync(join(ROOT, 'node_modules/.bin/turbo'));
  const rows: Record<string, string>[] = [];
  let problems = 0;
  if (stalePossible) { try { prefetchHashes(comps.flatMap(sourcesOf)); } catch { stalePossible = false; } }
  await Promise.all(comps.map(async (comp) => {
    const where = whereRunning(comp, cons);
    const conPresent = cons.get(comp.name);
    const pidInfo = localInfo(comp.name);
    const orphan = pidInfo && !localPid(comp.name);
    if (rt && !where.includes(rt)) { if (comp.optional || !isProcess(comp)) return; }
    if (comp.optional && !where.length && !conPresent) return;
    let state = where.length > 1 ? 'conflict' : where.length ? 'running' : conPresent ? conPresent.state : 'stopped';
    if (orphan && !where.includes('local')) state = 'orphan';
    if (!isProcess(comp)) state = '-';
    let health = '-';
    if (where.length === 1) {
      const h = await checkHealth(comp, where[0]!, 30_000);
      health = h.detail === 'no health check' ? 'running' : h.ok ? 'healthy' : 'unhealthy';
    }
    let build = '-';
    if (comp.runtimes.podman?.via) build = `via ${comp.runtimes.podman.via}`;
    else if (where[0] === 'local') build = 'source (watch)';
    else if (comp.runtimes.podman?.build && conPresent) {
      build = conPresent.hash;
      if (stalePossible) {
        try { if (imageHash(comp) !== conPresent.hash) build += ' (stale)'; } catch { stalePossible = false; }
      }
    } else if (comp.runtimes.podman?.image && conPresent) build = 'pinned';
    const port = mainPort(comp);
    const since = where[0] === 'local' ? pidInfo?.started : where[0] === 'podman' ? conPresent?.started : undefined;
    if (['conflict', 'orphan'].includes(state) || health === 'unhealthy') problems++;
    rows.push({
      component: comp.name, category: comp.category, runtime: where.join('+') || '-', state, health,
      route: comp.route ?? '-', endpoint: port && isProcess(comp) ? `127.0.0.1:${port}${where[0] === 'local' && localPid(comp.name) ? ` (pid ${localPid(comp.name)})` : ''}` : '-',
      build, uptime: since ? ago(since) : '-',
    });
  }));
  const rank = ['infra', 'service', 'ui', 'tool'];
  const sorted = order(comps).sort((a, b) => rank.indexOf(a.category) - rank.indexOf(b.category))
    .map((x) => rows.find((r) => r.component === x.name)).filter((r): r is Record<string, string> => !!r);
  if (json) { process.stdout.write(JSON.stringify(sorted, null, 2) + '\n'); return problems ? 1 : 0; }
  const cols = ['component', 'category', 'runtime', 'state', 'health', 'route', 'endpoint', 'build', 'uptime'];
  const width = Object.fromEntries(cols.map((k) => [k, Math.max(k.length, ...sorted.map((r) => r[k]!.length))]));
  const colour = (k: string, v: string) => {
    const pad = v.padEnd(width[k]!);
    if (k === 'runtime') return v === 'podman' ? c.blue(pad) : v === 'local' ? c.cyan(pad) : v === '-' ? c.dim(pad) : c.red(pad);
    if (k === 'state') return v === 'running' ? c.green(pad) : ['conflict', 'orphan'].includes(v) ? c.red(pad) : c.dim(pad);
    if (k === 'health') return v === 'healthy' ? c.green(pad) : v === 'unhealthy' ? c.red(pad) : c.dim(pad);
    if (k === 'build' && v.includes('stale')) return c.yellow(pad);
    return pad;
  };
  process.stdout.write(c.bold(cols.map((k) => k.toUpperCase().padEnd(width[k]!)).join('  ')) + '\n');
  for (const r of sorted) process.stdout.write(cols.map((k) => colour(k, r[k]!)).join('  ') + '\n');
  process.stdout.write(c.dim(`\nentry point: ${env['D4_PUBLIC_URL']}  ·  logs: run/.run/logs  ·  `) + (problems ? c.red(`${problems} problem(s)`) : c.green('no problems')) + '\n');
  const legacy = legacyContainers();
  if (legacy.length) process.stdout.write(c.yellow(`old compose containers still present: ${legacy.join(', ')} (run/run.sh podman:stack:deploy replaces them)\n`));
  return problems ? 1 : 0;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
