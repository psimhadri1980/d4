// The two runtimes. podman: one container per component, `d4-<name>`, on the host network (no
// networks are created; every component listens on 127.0.0.1:<port>). local: a detached process
// on local Node with a pid file and a log under run/.run. Health is polled by run.sh itself
// (`podman healthcheck run` every 5 s), because some Podman setups never run health checks.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { c, capture, captureAsync, elapsed, exec, log, RunError, sleep } from './log.ts';
import { containerName, mainPort, ROOT, STATE_DIR, type Component } from './components.ts';
import { baseEnv, ENGINE, interpolate, writeComponentEnv } from './env.ts';
import { toolEnv } from './build.ts';

const PODMAN_POLL_MS = 5_000;
const LOCAL_POLL_MS = 2_000;
const pidFile = (name: string) => join(STATE_DIR, 'pids', `${name}.json`);
export const localLog = (name: string) => join(STATE_DIR, 'logs', `${name}.local.log`);

interface ContainerInfo { name: string; state: string; image: string; hash: string; started: string; health: boolean }

/** Every container run.sh manages (label d4.component), in one call. */
export function containers(): Map<string, ContainerInfo> {
  const r = capture(ENGINE, ['ps', '-a', '--filter', 'label=d4.component', '--format', 'json']);
  const out = new Map<string, ContainerInfo>();
  if (r.code !== 0) return out;
  const list = JSON.parse(r.out || '[]') as { Names: string[]; State: string; Image: string; Labels: Record<string, string>; StartedAt: number; Status: string }[];
  for (const x of list) {
    const name = x.Labels?.['d4.component'];
    if (!name || x.Labels['d4.tenant']) continue;
    out.set(name, { name, state: x.State, image: x.Image, hash: x.Labels['d4.hash'] ?? '', started: x.StartedAt ? new Date(x.StartedAt * 1000).toISOString() : '', health: x.Labels['d4.health'] === 'yes' });
  }
  return out;
}

/** Containers from the old compose setup (`d4-<service>-1`), which hold the same ports. */
export function legacyContainers(): string[] {
  return capture(ENGINE, ['ps', '-a', '--filter', 'label=com.docker.compose.project=d4', '--format', '{{.Names}}']).out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** The shell health command of a component, as Podman runs it inside the container. */
function healthCmd(comp: Component): string | undefined {
  if (comp.health?.cmd) return interpolate(comp.health.cmd, baseEnv(), comp.rel);
  if (comp.health?.http) return `wget -qO- http://127.0.0.1:${mainPort(comp)}${comp.health.http} >/dev/null`;
  return undefined;
}

/** `podman run` arguments for a component, from runtimes.podman in its component.yaml. */
function runArgs(comp: Component, image: string, envFile: string, envHash: string): string[] {
  const spec = comp.runtimes.podman!;
  const env = baseEnv();
  const hc = healthCmd(comp);
  const args = ['run', '-d', '--name', containerName(comp.name), '--network', 'host',
    '--label', `d4.component=${comp.name}`, '--label', `d4.hash=${image.split(':').pop()}`, '--label', `d4.env=${envHash}`, '--label', `d4.health=${hc ? 'yes' : 'no'}`,
    '--env-file', envFile];
  if (spec.readOnly) args.push('--read-only');
  for (const t of spec.tmpfs ?? []) args.push('--tmpfs', t);
  for (const m of spec.mounts ?? []) {
    const src = join(ROOT, interpolate(m.src, env, comp.rel));
    if (!existsSync(src)) throw new RunError(`${comp.name}: mount source ${src} does not exist`);
    args.push('-v', `${src}:${m.dst}:${m.ro ? 'ro,' : ''}z`);
  }
  for (const v of spec.volumes ?? []) args.push('-v', `${v.name}:${v.dst}`);
  if (spec.memory) args.push('--memory', spec.memory);
  if (spec.cpus) args.push('--cpus', String(spec.cpus));
  if (spec.shm) args.push('--shm-size', spec.shm);
  if (spec.restart) args.push('--restart', spec.restart);
  if (spec.user) args.push('--user', spec.user);
  if (spec.entrypoint) args.push('--entrypoint', spec.entrypoint);
  // Podman may never run these on its own (see waitHealthy); they still define the check.
  if (hc) args.push('--health-cmd', hc, '--health-interval', '5s', '--health-retries', '3', '--health-timeout', '10s');
  args.push(image, ...(spec.command ?? []).map((a) => interpolate(a, env, comp.rel)));
  return args;
}

function podmanLogsTail(comp: Component, lines = 40): string[] {
  const r = capture(ENGINE, ['logs', '--tail', String(lines), containerName(comp.name)]);
  return (r.out + r.err).split('\n').filter((l) => l.trim()).slice(-lines);
}

/** The owner of a TCP port on this machine (empty when free). */
export function portOwner(port: number): string {
  const r = capture('ss', ['-Hltnp', `sport = :${port}`]);
  if (!r.out.trim()) return '';
  return /users:\(\("([^"]+)"/.exec(r.out)?.[1] ?? 'unknown process';
}

/**
 * Starts (or recreates) a component's container. Recreated when the image or its settings changed,
 * or when `recreate`; started again when stopped; left alone when already running unchanged.
 */
export async function podmanStart(comp: Component, image: string, recreate: boolean): Promise<'started' | 'unchanged' | 'recreated'> {
  const { file, env } = writeComponentEnv(comp, 'podman');
  const envHash = createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 12);
  const name = containerName(comp.name);
  const cur = containers().get(comp.name);
  if (cur) {
    const same = cur.image === image && capture(ENGINE, ['inspect', '-f', '{{index .Config.Labels "d4.env"}}', name]).out.trim() === envHash;
    if (same && !recreate) {
      if (cur.state === 'running') { log.info(`${name} is already running this image and settings`); return 'unchanged'; }
      await exec(ENGINE, ['start', name], { logName: `${comp.name}.podman.log`, label: `starting ${name}` });
      return 'started';
    }
    log.info(same ? `recreating ${name}` : `replacing ${name}: ${cur.image === image ? 'its settings changed' : `new image (was ${cur.image.split(':').pop()})`}`);
    await exec(ENGINE, ['rm', '-f', '-t', '10', name], { logName: `${comp.name}.podman.log`, label: `removing ${name}` });
  }
  for (const p of Object.values(comp.ports)) {
    const owner = portOwner(p);
    if (owner) throw new RunError(`${comp.name}: port ${p} is already in use by '${owner}'`, {
      hint: `stop whatever listens on ${p} (run/run.sh status shows D4's own components; old compose containers are removed by run/run.sh podman:stack:stop)`,
    });
  }
  await exec(ENGINE, runArgs(comp, image, file, envHash), {
    logName: `${comp.name}.podman.log`, label: `creating ${name}`,
    hint: 'the container could not be created; the podman output above says why',
  });
  return cur ? 'recreated' : 'started';
}

export async function podmanStop(comp: Component, remove = false): Promise<boolean> {
  const name = containerName(comp.name);
  const cur = containers().get(comp.name);
  if (!cur) return false;
  if (remove) await exec(ENGINE, ['rm', '-f', '-t', '10', name], { logName: `${comp.name}.podman.log`, label: `removing ${name}` });
  else if (cur.state === 'running') await exec(ENGINE, ['stop', '-t', '10', name], { logName: `${comp.name}.podman.log`, label: `stopping ${name}` });
  else return false;
  return true;
}

/** Runs the health check once: podman `healthcheck run`, or an HTTP probe for local processes. */
export async function checkHealth(comp: Component, rt: 'local' | 'podman', maxAgeMs = 0): Promise<{ ok: boolean; detail: string }> {
  if (rt === 'podman') {
    if (!healthCmd(comp)) return { ok: true, detail: 'no health check' };
    // A result Podman (or an earlier run.sh) recorded within maxAgeMs is reused.
    if (maxAgeMs > 0) {
      const r = await captureAsync(ENGINE, ['inspect', '-f', '{{json .State.Health}}', containerName(comp.name)]);
      try {
        const h = JSON.parse(r.out) as { Log?: { End: string; ExitCode: number; Output: string }[] };
        const last = h.Log?.at(-1);
        if (last && Date.now() - Date.parse(last.End) < maxAgeMs) return { ok: last.ExitCode === 0, detail: last.Output.trim().split('\n').pop() ?? '' };
      } catch { /* none recorded: run it */ }
    }
    const r = await captureAsync(ENGINE, ['healthcheck', 'run', containerName(comp.name)]);
    return { ok: r.code === 0, detail: (r.out + r.err).trim().split('\n').pop() ?? '' };
  }
  const path = comp.health?.http;
  const port = mainPort(comp);
  if (!path || !port) return { ok: true, detail: 'no health check' };
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, timeout: 4000 }, (res) => {
      res.resume();
      resolve({ ok: (res.statusCode ?? 500) < 400, detail: `HTTP ${res.statusCode}` });
    });
    req.on('error', (e) => resolve({ ok: false, detail: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: 'timed out' }); });
    req.end();
  });
}

/**
 * Waits until a started component is healthy: every 5 s `podman healthcheck run` (the workaround
 * for Podman setups that never run checks themselves), every 2 s an HTTP probe for local ones.
 * Fails fast when the process exits, with its last log lines.
 */
export async function waitHealthy(comp: Component, rt: 'local' | 'podman'): Promise<void> {
  const timeout = (comp.health?.timeout ?? 120) * 1000;
  const t = Date.now();
  const poll = rt === 'podman' ? PODMAN_POLL_MS : LOCAL_POLL_MS;
  let lastPrint = 0;
  for (;;) {
    if (rt === 'podman') {
      const state = capture(ENGINE, ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', containerName(comp.name)]).out.trim();
      if (!state.startsWith('running'))
        throw new RunError(`${comp.name}: the container stopped while starting (${state || 'gone'})`, { tail: podmanLogsTail(comp), hint: `run/run.sh podman:${comp.name}:logs shows all of its output` });
    } else if (!localPid(comp.name)) {
      throw new RunError(`${comp.name}: the local process exited while starting`, { tail: tailFile(localLog(comp.name)), logFile: localLog(comp.name) });
    }
    const h = await checkHealth(comp, rt);
    if (h.ok) { log.ok(`${comp.name} is healthy on ${rt} (${elapsed(t)})`); return; }
    if (Date.now() - t > timeout)
      throw new RunError(`${comp.name}: not healthy after ${comp.health?.timeout ?? 120}s on ${rt} (last check: ${h.detail || 'failed'})`, {
        tail: rt === 'podman' ? podmanLogsTail(comp) : tailFile(localLog(comp.name)),
        ...(rt === 'local' && { logFile: localLog(comp.name) }),
        hint: `run/run.sh ${rt}:${comp.name}:logs shows all of its output; health.timeout in ${comp.rel}/component.yaml sets the limit`,
      });
    if (Date.now() - lastPrint >= 10_000 || lastPrint === 0) {
      log.detail(`waiting for ${comp.name} to become healthy (${elapsed(t)} of ${timeout / 1000}s)${h.detail ? `: ${h.detail.slice(0, 100)}` : ''}`);
      lastPrint = Date.now();
    }
    await sleep(poll);
  }
}

function tailFile(file: string, lines = 40): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).slice(-lines);
}

interface PidInfo { pid: number; started: string; command: string }

export function localInfo(name: string): PidInfo | undefined {
  try { return JSON.parse(readFileSync(pidFile(name), 'utf8')) as PidInfo; } catch { return undefined; }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The pid of a running local process, or undefined. */
export function localPid(name: string): number | undefined {
  const info = localInfo(name);
  return info && alive(info.pid) ? info.pid : undefined;
}

/** Starts a component's local command detached, behind the gateway at the same port as its container. */
export async function localStart(comp: Component): Promise<'started' | 'unchanged'> {
  if (localPid(comp.name)) { log.info(`${comp.name} is already running on local Node (pid ${localPid(comp.name)})`); return 'unchanged'; }
  for (const p of Object.values(comp.ports)) {
    const owner = portOwner(p);
    if (owner) throw new RunError(`${comp.name}: port ${p} is already in use by '${owner}'`, { hint: 'run/run.sh status shows where each component runs' });
  }
  const { env } = writeComponentEnv(comp, 'local');
  const command = interpolate(comp.runtimes.local!.command, { ...baseEnv(), ...env }, comp.rel);
  mkdirSync(join(STATE_DIR, 'pids'), { recursive: true });
  mkdirSync(join(STATE_DIR, 'logs'), { recursive: true });
  const logFile = localLog(comp.name);
  const fd = openSync(logFile, 'a');
  writeFileSync(fd, `\n==== ${new Date().toISOString()} $ ${command}\n`);
  log.cmd(command);
  const child = spawn('bash', ['-c', `exec ${command}`], { cwd: ROOT, env: { ...toolEnv(), ...env }, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  if (!child.pid) throw new RunError(`${comp.name}: could not start '${command}'`);
  child.unref();
  writeFileSync(pidFile(comp.name), JSON.stringify({ pid: child.pid, started: new Date().toISOString(), command }));
  log.info(`${comp.name} started on local Node (pid ${child.pid}), log: ${logFile}`);
  return 'started';
}

/** Stops a local process and everything it started (its process group). */
export async function localStop(comp: Component): Promise<boolean> {
  const pid = localPid(comp.name);
  rmSync(pidFile(comp.name), { force: true });
  if (!pid) return false;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(200);
  if (alive(pid)) {
    log.warn(`${comp.name} (pid ${pid}) did not stop within 10s: killing it`);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
  return true;
}

/** Where a component runs now: on Podman, on local Node, both (a conflict) or nowhere. */
export function whereRunning(comp: Component, cons = containers()): ('podman' | 'local')[] {
  const out: ('podman' | 'local')[] = [];
  const name = comp.runtimes.podman?.via ?? comp.name;
  if (!comp.runtimes.podman?.via && cons.get(name)?.state === 'running') out.push('podman');
  if (localPid(comp.name)) out.push('local');
  return out;
}

export const describeRuntime = (rt: string) => (rt === 'podman' ? c.blue('podman') : c.cyan('local'));
