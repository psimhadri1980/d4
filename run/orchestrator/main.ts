// run/run.sh <runtime>:<component>:<command> [args]: the one entry point for building, running
// and testing D4. See `run/run.sh help` and docs/DEVELOPER_GUIDE.md.
import { join } from 'node:path';
import { c, initLogs, log, opts, reportError, RunError } from './log.ts';
import { CATEGORIES, component, isProcess, loadComponents, mainPort, RUNTIMES, runtimeFor, select, STATE_DIR, type Runtime } from './components.ts';
import { build, execIn, logs, plan, reset, runTool, shell, status, stop, up } from './lifecycle.ts';
import { doctor, keycloakExec, opsExec, publish, token } from './extras.ts';
import { test } from './test.ts';

const COMMANDS = ['build', 'deploy', 'start', 'stop', 'reset', 'status', 'logs', 'test', 'exec', 'shell'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `${c.bold('usage:')} run/run.sh [<runtime>:]<component>:<command> [args] [--verbose] [--yes]
       run/run.sh ls | status | doctor | help [component]

${c.bold('runtime')}    local (local Node 24) | podman (containers on the host network). Optional: each
           component has a default; infra and the gateway always run on podman.
${c.bold('component')}  a name (api, web-plan, postgres), a category (${CATEGORIES.join(', ')}), a group
           (observability), stack (everything but tools and optional parts) or a list (api,worker)
${c.bold('command')}    build    compile (turbo, cached) and, for podman, package the image if inputs changed
           deploy   build, stop it on the other runtime, start it here, wait until healthy
           start    start without building (builds only what was never built)
           stop     stop it (wherever it runs, or on the runtime given)
           reset    stop, then delete its container and volumes (podman) or its dist/ (local); --yes
           status   where each component runs, state, health, route, build (--json)
           logs     follow its output (-n N, --no-follow)
           test     [unit|integration|static|e2e|smoke] [--all] [--base ref] [-- extra args]
                    changed packages only, within the component, unless --all
           exec     -- <command>: in the running component, or run a tool once (cli, ops)
           shell    a shell in its container, or with its local settings

${c.bold('examples')}   run/run.sh podman:stack:deploy        run/run.sh local:api:deploy
           run/run.sh status                      run/run.sh api:test
           run/run.sh local:web-plan:test e2e     run/run.sh podman:cli:exec -- import samples/ubs-banking.yaml
           run/run.sh keycloak:exec -- token      run/run.sh ops:exec -- tenant create t_acme "Acme"`;

function ls(): void {
  const comps = [...loadComponents().values()].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
  const rows = comps.map((x) => [x.name, x.category + (x.group ? `/${x.group}` : ''), RUNTIMES.filter((r) => x.runtimes[r]).map((r) => (r === x.runtimes.default ? `${r}*` : r)).join(' '), mainPort(x) ? String(mainPort(x)) : '-', x.optional ? 'optional' : '', x.description]);
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i]!.length), ['COMPONENT', 'CATEGORY', 'RUNTIMES', 'PORT', ''][i]!.length));
  process.stdout.write(c.bold(['COMPONENT', 'CATEGORY', 'RUNTIMES', 'PORT', ''].map((h, i) => h.padEnd(w[i]!)).join('  ') + '  DESCRIPTION') + '\n');
  for (const r of rows) process.stdout.write(r.slice(0, 5).map((v, i) => v.padEnd(w[i]!)).join('  ') + '  ' + c.dim(r[5]!) + '\n');
  process.stdout.write(c.dim('\n* default runtime\n'));
}

function help(name?: string): void {
  if (!name) { process.stdout.write(USAGE + '\n'); return; }
  const x = component(name);
  process.stdout.write(`${c.bold(x.name)} (${x.category}) ${c.dim(x.rel + '/component.yaml')}\n  ${x.description}\n`);
  process.stdout.write(`  runtimes: ${RUNTIMES.filter((r) => x.runtimes[r]).join(', ')} (default ${x.runtimes.default})\n`);
  if (x.dependsOn.length) process.stdout.write(`  depends on: ${x.dependsOn.join(', ')}\n`);
  if (Object.keys(x.ports).length) process.stdout.write(`  ports: ${Object.entries(x.ports).map(([k, v]) => `${k} ${v}`).join(', ')} (127.0.0.1)\n`);
  if (x.route) process.stdout.write(`  route: ${x.route}\n`);
  if (x.test.e2e.length) process.stdout.write(`  browser specs: ${x.test.e2e.join(' ')}\n`);
  const cmds = isProcess(x) ? COMMANDS : ['build', 'test', 'exec'];
  process.stdout.write(`  commands: ${cmds.join(', ')}\n`);
}

/** Splits `local:api:deploy`, `api:deploy` or `stack:status`. */
function parseTarget(spec: string): { rt: Runtime | undefined; sel: string; cmd: Command } {
  const parts = spec.split(':');
  let rt: Runtime | undefined;
  if ((RUNTIMES as readonly string[]).includes(parts[0]!)) rt = parts.shift() as Runtime;
  else if (['loc', 'con'].includes(parts[0]!)) throw new RunError(`'${parts[0]}' is now '${parts[0] === 'loc' ? 'local' : 'podman'}'`, { code: 2 });
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new RunError(`expected [<runtime>:]<component>:<command>, got '${spec}'`, { hint: 'run/run.sh help', code: 2 });
  const cmd = parts[1] as Command;
  if (!COMMANDS.includes(cmd)) throw new RunError(`unknown command '${parts[1]}' (commands: ${COMMANDS.join(', ')})`, { code: 2 });
  return { rt, sel: parts[0], cmd };
}

async function main(argv: string[]): Promise<number> {
  const flags = new Set<string>();
  const args: string[] = [];
  let passthrough = false;
  for (const a of argv) {
    if (passthrough) { args.push(a); continue; }
    if (a === '--') { passthrough = true; args.push(a); continue; }
    if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') flags.add('json');
    else args.push(a);
  }
  initLogs(join(STATE_DIR, 'logs'));
  const first = args.shift();
  if (!first || first === 'help' || first === '-h' || first === '--help') { help(args[0]); return first ? 0 : 2; }
  if (first === 'ls') { ls(); return 0; }
  if (first === 'doctor') return doctor();
  if (first === 'status') return status(select('stack').concat([...loadComponents().values()].filter((x) => x.optional || !isProcess(x))), undefined, flags.has('json'));

  const { rt, sel, cmd } = parseTarget(first);
  const comps = select(sel);
  const single = comps.length === 1 && sel === comps[0]!.name;
  const rest = args.filter((a) => a !== '--');
  const after = args.includes('--') ? args.slice(args.indexOf('--') + 1) : rest;

  switch (cmd) {
    case 'build': await build(plan(comps, rt, single)); return 0;
    case 'deploy': await up(plan(comps, rt, single), { build: true }); return 0;
    case 'start': await up(plan(comps.filter(isProcess), rt, single), { build: false }); return 0;
    case 'stop': await stop(plan(comps, undefined, false), rt); return 0;
    case 'reset': await reset(plan(comps, undefined, false), rt, sel === 'stack'); return 0;
    case 'status': return status(sel === 'stack' ? comps.concat([...loadComponents().values()].filter((x) => x.optional)) : comps, rt, flags.has('json'));
    case 'logs': await logs(plan(comps, rt, single), rt, rest); return 0;
    case 'test': await test(sel === 'stack' ? 'stack' : single ? comps[0]! : failMany(sel, 'test'), rt, args); return 0;
    case 'shell': await shell(onlyOne(comps, sel, 'shell'), rt); return 0;
    case 'exec': {
      const comp = onlyOne(comps, sel, 'exec');
      if (comp.name === 'keycloak' && (await keycloakExec(after))) return 0;
      if (comp.name === 'ops' && (await opsExec(rt ?? 'podman', after))) return 0;
      if (comp.runtimes.podman?.via === 'ui-modules' && after[0] === 'publish') { await publish(comp, after); return 0; }
      // The CLI signs in as dev-admin unless D4_TOKEN is set.
      if (comp.name === 'cli') { await runTool(comp, runtimeFor(comp, rt), after, { env: { D4_TOKEN: process.env['D4_TOKEN'] || (await token('dev-admin')) } }); return 0; }
      await execIn(comp, rt, after);
      return 0;
    }
  }
  return 2;
}

function onlyOne<T>(comps: T[], sel: string, cmd: string): T {
  if (comps.length !== 1) throw new RunError(`${cmd} takes one component; '${sel}' selects ${comps.length}`, { code: 2 });
  return comps[0]!;
}
function failMany(sel: string, cmd: string): never {
  throw new RunError(`${cmd} takes one component or stack; '${sel}' selects several`, { hint: 'run them one at a time, or use stack', code: 2 });
}

const started = Date.now();
main(process.argv.slice(2)).then(
  (code) => { if (code === 0 && Date.now() - started > 3000) log.raw(c.dim(`finished in ${((Date.now() - started) / 1000).toFixed(1)}s`)); process.exit(code); },
  (e) => process.exit(reportError(e)),
);
