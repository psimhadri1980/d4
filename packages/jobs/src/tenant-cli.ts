import { loadConfig, neo4j, postgres } from '@d4/config';
import { checkTenant, ManualInstanceDriver, provisionTenant, graphConfig } from '@d4/infra';
import { createDb, TenantStore } from '@d4/db';

/**
 * Operator tool for tenants (run in the API image; `deploy/dev.sh tenant-*` wraps it).
 *
 *   create <tenant> --name "Acme" --bolt bolt://host:7687 --secret file:neo4j-t_acme [--slug acme]
 *   list | check <tenant> | suspend <tenant> | resume <tenant> | delete <tenant>
 *
 * Environment: POSTGRES_URL (or its parts), NEO4J_USER, NEO4J_PASSWORD, and optionally
 * NEO4J_HOSTS and NEO4J_SECRETS_DIR (see TenantGraphs).
 */
const USAGE = `usage: tenant-cli create <tenant> --name <name> --bolt <uri> --secret <ref> [--slug <slug>] [--version <neo4j>]
       tenant-cli list | check <tenant> | suspend <tenant> | resume <tenant> | delete <tenant>`;

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!;
    if (!k.startsWith('--') || args[i + 1] === undefined) throw new Error(USAGE);
    out[k.slice(2)] = args[i + 1]!;
  }
  return out;
}

async function main() {
  const [command, tenantId, ...rest] = process.argv.slice(2);
  if (!command) throw new Error(USAGE);
  const config = loadConfig({ ...postgres, ...neo4j });
  const graph = graphConfig(config);
  const handle = createDb(config.POSTGRES_URL, 2);
  const tenants = new TenantStore(handle.db);
  const need = () => {
    if (!tenantId) throw new Error(USAGE);
    return tenantId;
  };
  try {
    switch (command) {
      case 'create': {
        const f = flags(rest);
        if (!f['name'] || !f['bolt'] || !f['secret']) throw new Error(USAGE);
        const id = need();
        const driver = new ManualInstanceDriver({ boltUri: f['bolt'], secretRef: f['secret'], neo4jVersion: f['version'] ?? '5.26' });
        const r = await provisionTenant(handle.db, driver, { tenantId: id, slug: f['slug'] ?? id.replace(/^t_/, '').replace(/_/g, '-'), name: f['name'] }, { graph, log: (s) => console.log(`  ${s}`) });
        console.log(`Tenant ${r.tenantId} is active; default workspace ${r.workspaceId}.`);
        break;
      }
      case 'list':
        for (const { tenant, instance } of await tenants.listAll()) {
          console.log(`${tenant.id}\t${tenant.status}\t${tenant.name}\t${instance ? `${instance.boltUri} (${instance.status})` : 'no instance'}`);
        }
        break;
      case 'check': {
        const r = await checkTenant(handle.db, need(), graph);
        console.log(`${r.ok ? 'ok' : 'NOT OK'}: ${r.detail}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'suspend':
      case 'resume':
      case 'delete': {
        const id = need();
        if (id === 't_local' && command === 'delete') throw new Error('The local development tenant cannot be deleted');
        const status = command === 'suspend' ? 'suspended' : command === 'resume' ? 'active' : 'deleted';
        if (!(await tenants.setStatus(id, status))) throw new Error(`Tenant '${id}' not found`);
        // Running services notice within their auth cache period (about a minute).
        console.log(`Tenant ${id} is ${status}.${command === 'delete' ? ' Its data is kept; remove the instance separately.' : ''}`);
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    await handle.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
