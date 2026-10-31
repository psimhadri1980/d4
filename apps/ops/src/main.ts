import { migrate, quota, seed } from './db';
import { schema } from './schema';
import { tenant } from './tenant';

/**
 * d4-ops: operator commands, in their own small image (init jobs, `deploy/dev-infra.sh`).
 * Settings come from the environment like every service (POSTGRES_URL or its parts, NEO4J_*).
 */
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { migrate, seed, schema, tenant, quota };

const USAGE = `usage: d4-ops <command>
  migrate                         control-plane migrations
  seed                            migrations, then the local tenant, metamodel and workspace
  schema [tenant]                 Neo4j constraints and indexes (default t_local)
  tenant create|list|check|suspend|resume|delete …
  quota <tenant> [metric=value …] show or change a tenant's limits`;

const [command, ...args] = process.argv.slice(2);
const run = command ? COMMANDS[command] : undefined;
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
run(args).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
