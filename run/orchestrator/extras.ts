// Operator tasks behind exec: tokens (keycloak), tenant graphs (ops), Keycloak tenant users,
// web module releases (publish), plus doctor. Requests go to the gateway at 127.0.0.1 with the
// public Host header, so no name has to resolve and tokens name the public issuer.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { c, capture, exec, log, RunError, sleep } from './log.ts';
import { component, loadComponents, mainPort, ROOT, RUN_DIR, type Component } from './components.ts';
import { baseEnv, ENGINE } from './env.ts';
import { containers, legacyContainers, portOwner } from './runtime.ts';
import { runTool } from './lifecycle.ts';

/** An HTTP request to the gateway (127.0.0.1:D4_PORT) as the browser would send it. */
export function gatewayRequest(method: string, path: string, body?: string, bearer?: string, type = 'application/json'): Promise<{ status: number; body: string }> {
  const env = baseEnv();
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: Number(env['D4_PORT']), method, path, timeout: 30_000,
      headers: { Host: `${env['D4_HOST']}:${env['D4_PORT']}`, ...(bearer && { Authorization: `Bearer ${bearer}` }), ...(body !== undefined && { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', (e) => reject(new RunError(`${method} ${path} through the gateway failed: ${e.message}`, { hint: 'is the gateway running? run/run.sh status' })));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** An access token for a local dev user (password DEV_USER_PASSWORD), issued for the public URL. */
export async function token(user: string): Promise<string> {
  const env = baseEnv();
  const form = new URLSearchParams({ client_id: env['OIDC_CLIENT_ID'] ?? 'd4-web', grant_type: 'password', username: user, password: env['DEV_USER_PASSWORD'] ?? '' }).toString();
  const r = await gatewayRequest('POST', '/auth/realms/d4/protocol/openid-connect/token', form, undefined, 'application/x-www-form-urlencoded');
  if (r.status !== 200) throw new RunError(`Keycloak refused a token for ${user}: HTTP ${r.status}`, { tail: [r.body.slice(0, 400)], hint: 'is keycloak healthy (run/run.sh status), and does the user exist?' });
  return (JSON.parse(r.body) as { access_token: string }).access_token;
}

/** `keycloak:exec -- token [user]` and `-- tenant-user <t_id> <username> [role ...]`. */
export async function keycloakExec(args: string[]): Promise<boolean> {
  const env = baseEnv();
  if (args[0] === 'token') { process.stdout.write((await token(args[1] ?? 'dev-admin')) + '\n'); return true; }
  if (args[0] === 'tenant-user') {
    await exec(join(component('keycloak').dir, 'tenant-user.sh'), args.slice(1), {
      env: { ...process.env, KEYCLOAK_ADMIN_PASSWORD: env['KEYCLOAK_ADMIN_PASSWORD'] ?? '', DEV_USER_PASSWORD: env['DEV_USER_PASSWORD'] ?? '', D4_CONTAINER_ENGINE: ENGINE, KEYCLOAK_PORT: env['PORT_KEYCLOAK'] ?? '8080' },
      inherit: true,
    });
    return true;
  }
  return false;
}

/** Tenant graph ports: bolt from 7701 up, HTTP at bolt + 100; both on 127.0.0.1. */
function freeTenantPort(): number {
  const taken = new Set(capture(ENGINE, ['ps', '-a', '--filter', 'label=d4.tenant', '--format', '{{index .Labels "d4.bolt-port"}}']).out.split('\n').map(Number));
  for (let p = 7701; p < 7800; p++) if (!taken.has(p) && !portOwner(p) && !portOwner(p + 100)) return p;
  throw new RunError('no free tenant graph port between 7701 and 7799');
}

/**
 * `ops:exec -- tenant create t_<id> "<name>"`: the tenant's own Neo4j container (on the host
 * network, its own ports), then the control-plane registration, schema and seed (d4-ops).
 * `-- tenant remove t_<id>`: deregisters and stops it (its volume is kept). Other ops commands pass through.
 */
export async function opsExec(rt: 'local' | 'podman', args: string[]): Promise<boolean> {
  if (args[0] !== 'tenant' || !['create', 'remove'].includes(args[1] ?? '')) return false;
  const ops = component('ops');
  const id = args[2] ?? '';
  const name = `d4-neo4j-${id}`;
  if (args[1] === 'remove') {
    if (!/^t_[a-z0-9_]+$/.test(id)) throw new RunError('usage: run.sh ops:exec -- tenant remove t_<id>', { code: 2 });
    await runTool(ops, rt, ['tenant', 'delete', id]);
    if (capture(ENGINE, ['rm', '-f', '-t', '10', name]).code === 0) log.ok(`stopped ${name} (volume ${name}-data kept)`);
    return true;
  }
  const title = args[3] ?? '';
  if (!/^t_[a-z0-9][a-z0-9_]{1,30}$/.test(id) || !title) throw new RunError('usage: run.sh ops:exec -- tenant create t_<id> "<name>"', { code: 2 });
  const secret = join(RUN_DIR, 'secrets', `neo4j-${id}`);
  if (!existsSync(secret) || statSync(secret).size === 0) { writeFileSync(secret, randomBytes(16).toString('hex') + '\n', { mode: 0o600 }); log.info(`generated the graph password in ${relative(ROOT, secret)}`); }
  const password = readFileSync(secret, 'utf8').trim();
  if (capture(ENGINE, ['container', 'exists', name]).code !== 0) {
    const env = baseEnv();
    const bolt = freeTenantPort();
    log.info(`starting ${name}: bolt 127.0.0.1:${bolt}, http 127.0.0.1:${bolt + 100}`);
    await exec(ENGINE, ['run', '-d', '--name', name, '--network', 'host', '--label', `d4.tenant=${id}`, '--label', `d4.bolt-port=${bolt}`, '--restart', 'unless-stopped',
      '-v', `${name}-data:/data`, '-v', `${name}-plugins:/plugins`,
      '-e', `NEO4J_AUTH=neo4j/${password}`, '-e', 'NEO4J_PLUGINS=["apoc"]',
      '-e', 'NEO4J_dbms_security_procedures_unrestricted=apoc.*', '-e', 'NEO4J_dbms_security_procedures_allowlist=apoc.*',
      '-e', 'NEO4J_server_default__listen__address=127.0.0.1', '-e', `NEO4J_server_bolt_listen__address=127.0.0.1:${bolt}`, '-e', `NEO4J_server_http_listen__address=127.0.0.1:${bolt + 100}`,
      '-e', 'NEO4J_db_transaction_timeout=30s', '-e', 'NEO4J_server_memory_heap_initial__size=256m', '-e', 'NEO4J_server_memory_heap_max__size=384m',
      '-e', 'NEO4J_server_memory_pagecache_size=64m', '-e', 'NEO4J_db_memory_transaction_total_max=128m',
      '-e', 'NEO4J_server_jvm_additional=-XX:MaxDirectMemorySize=128m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -Xss512k',
      '--health-cmd', `cypher-shell -a bolt://127.0.0.1:${bolt} -u neo4j -p "$NEO4J_AUTH_PASSWORD" "RETURN 1" >/dev/null 2>&1`, '-e', `NEO4J_AUTH_PASSWORD=${password}`,
      '--memory', '900m', '--cpus', '1', env['NEO4J_IMAGE']!], { logName: `tenant-${id}.log`, label: `starting ${name}` });
    const t = Date.now();
    for (;;) {
      if (capture(ENGINE, ['healthcheck', 'run', name]).code === 0) break;
      if (Date.now() - t > 180_000) throw new RunError(`${name} did not become healthy in 180s`, { tail: capture(ENGINE, ['logs', '--tail', '30', name]).out.split('\n') });
      log.detail(`waiting for ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
      await sleep(5_000);
    }
    log.ok(`${name} is healthy`);
  }
  await runTool(ops, rt, ['tenant', 'create', id, '--name', title, '--bolt', `bolt://${name}:7687`, '--secret', `file:neo4j-${id}`]);
  log.info('restart local api/worker processes so they learn the new graph (run/run.sh local:api:stop then :start)');
  return true;
}

/**
 * `web-<name>:exec -- publish <version> [--activate] [--keep N] [--title T] [--framework F]`:
 * uploads the module's dist/ as an immutable release (D70) and optionally activates it.
 */
export async function publish(comp: Component, args: string[]): Promise<void> {
  const name = comp.name.replace(/^web-/, '');
  const version = args[1];
  if (!version) throw new RunError(`usage: run.sh ${comp.name}:exec -- publish <version> [--activate] [--keep N] [--title T] [--framework react|vanilla|other] [--entry file.js] [--dist dir|-]`, { code: 2 });
  const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] ?? d : d);
  const dist = opt('--dist', join(comp.dir, 'dist'));
  const entry = opt('--entry', `${name}.js`);
  const framework = opt('--framework', 'react');
  const tok = await token('dev-admin');
  const api = `/api/v1/admin/web-modules/${name}`;
  if (dist !== '-') {
    if (!existsSync(dist)) throw new RunError(`${dist} does not exist`, { hint: `run/run.sh local:${comp.name}:build builds it` });
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const manifest = { name, version, contract: 2, entry, framework, files: {} as Record<string, string> };
    const files: Record<string, string> = {};
    for (const f of walk(dist)) {
      const rel = relative(dist, f).split('\\').join('/');
      if (rel === 'manifest.json') continue;
      const buf = readFileSync(f);
      manifest.files[rel] = createHash('sha256').update(buf).digest('hex');
      files[rel] = buf.toString('base64');
    }
    log.info(`uploading ${Object.keys(files).length} files of ${name} ${version}`);
    const r = await gatewayRequest('POST', `${api}/releases`, JSON.stringify({ manifest, files }), tok);
    if (r.status === 201) log.ok(`released ${name} ${version}`);
    else if (r.status === 409) log.info(`${name} ${version} is already released; using it`);
    else throw new RunError(`release failed: HTTP ${r.status}`, { tail: [r.body.slice(0, 600)] });
  }
  if (args.includes('--activate')) {
    const me = await gatewayRequest('GET', '/api/v1/me', undefined, tok);
    const tenant = (JSON.parse(me.body) as { tenantId: string }).tenantId;
    const put = { title: opt('--title', name), entry: `/mfe/_r/${tenant}/${name}/${version}/${entry}`, version, contract: 2, framework };
    const r = await gatewayRequest('PUT', api, JSON.stringify(put), tok);
    if (r.status >= 300) throw new RunError(`activation failed: HTTP ${r.status}`, { tail: [r.body.slice(0, 600)] });
    log.ok(`activated ${name} ${version} for tenant ${tenant}`);
  }
  if (args.includes('--keep')) {
    const keep = Number(opt('--keep', '3'));
    const r = await gatewayRequest('GET', `${api}/releases`, undefined, tok);
    const list = JSON.parse(r.body) as { version: string; active?: boolean }[];
    for (const old of list.slice(0, Math.max(0, list.length - keep)).filter((x) => !x.active)) {
      const d = await gatewayRequest('DELETE', `${api}/releases/${old.version}`, undefined, tok);
      if (d.status < 300) log.ok(`deleted ${name} ${old.version}`); else log.warn(`could not delete ${name} ${old.version}: HTTP ${d.status}`);
    }
  }
}

/** doctor: everything run.sh relies on, with what to do about each failure. */
export async function doctor(): Promise<number> {
  let bad = 0;
  const check = (what: string, ok: boolean, fix: string, warnOnly = false) => {
    if (ok) log.ok(what);
    else if (warnOnly) log.warn(`${what}: ${fix}`);
    else { bad++; log.error(`${what}: ${fix}`); }
  };
  log.phase('Doctor');
  const v = capture(ENGINE, ['version', '--format', '{{.Client.Version}}']).out.trim();
  check(`${ENGINE} ${v || 'missing'}`, /^[45]\./.test(v), 'install Podman 4.4 or later');
  check(`Node ${process.version}`, process.version.startsWith('v24.'), 'install Node 24 (.node-version)');
  const info = capture(ENGINE, ['info', '--format', '{{.Host.Security.Rootless}} {{.Host.CgroupsVersion}}']).out.trim();
  check(`rootless, cgroups ${info.split(' ')[1] ?? '?'}`, info.startsWith('true'), 'run Podman as your user', true);
  const ctl = capture('cat', [`/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/cgroup.controllers`]).out;
  check('cgroup cpu and memory delegated (memory/cpu limits)', /memory/.test(ctl) && /cpu/.test(ctl), 'enable systemd delegation, or limits are ignored', true);
  try { loadComponents(); check(`component.yaml contract (${loadComponents().size} components)`, true, ''); } catch (e) { check('component.yaml contract', false, (e as Error).message); }
  const cons = containers();
  for (const comp of loadComponents().values()) {
    for (const p of Object.values(comp.ports)) {
      const owner = portOwner(p);
      if (!owner) continue;
      const ours = cons.get(comp.name)?.state === 'running' || existsSync(join(RUN_DIR, '.run/pids', `${comp.name}.json`));
      check(`port ${p} (${comp.name}) used by ${owner}`, ours, `free it, or another program holds a D4 port`, true);
    }
  }
  const restart = capture('systemctl', ['--user', 'is-enabled', 'podman-restart.service']).out.trim();
  check('podman-restart.service enabled (containers come back after a reboot)', restart === 'enabled', 'systemctl --user enable podman-restart.service, or run run/run.sh podman:stack:start after each boot', true);
  const legacy = legacyContainers();
  check('no containers from the old compose setup', !legacy.length, `${legacy.join(', ')}: run/run.sh podman:stack:deploy replaces them (volumes are kept)`, true);
  const running = [...cons.values()].find((x) => x.state === 'running' && x.health);
  if (running) check(`podman healthcheck run works (${running.name})`, capture(ENGINE, ['healthcheck', 'run', `d4-${running.name}`]).code !== 125, 'healthcheck run is not supported: health checks will fail', true);
  const gw = component('gateway');
  check(`gateway port ${mainPort(gw)} from host.conf`, !!mainPort(gw), 'set D4_PORT in host.conf');
  log.raw(bad ? c.red(`\n${bad} problem(s)`) : c.green('\nall checks passed'));
  return bad ? 1 : 0;
}
