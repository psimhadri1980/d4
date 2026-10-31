import { loadConfig, postgres } from '@d4/config';
import { applySettings, createDb, LOCAL_TENANT, runMigrations, seedLocal, UsageStore, type Db } from '@d4/db';

async function withDb(run: (db: Db) => Promise<void>) {
  const handle = createDb(loadConfig(postgres).POSTGRES_URL, 1);
  try {
    await run(handle.db);
  } finally {
    await handle.close();
  }
}

/** `d4-ops migrate`: control-plane migrations. */
export const migrate = () =>
  withDb(async (db) => {
    await runMigrations(db);
    console.log('Control-plane migrations applied.');
  });

/** `d4-ops seed`: migrations, then the local tenant, starter metamodel and default workspace (idempotent). */
export const seed = () =>
  withDb(async (db) => {
    await runMigrations(db);
    console.log(`Migrated and seeded tenant '${LOCAL_TENANT}':`, await seedLocal(db));
  });

/**
 * `d4-ops quota <tenant> [metric=value …]`: changes one tenant's limits (tenant admins can see
 * them but not change them) and prints its overrides; e.g. `elements=200000 jobsPerDay=unlimited`.
 */
export async function quota([tenant, ...settings]: string[]) {
  if (!tenant) throw new Error('usage: d4-ops quota <tenant> [metric=<number|unlimited|default> …]');
  await withDb(async (db) => {
    const store = new UsageStore(db);
    if (settings.length) await store.setOverrides(tenant, applySettings(await store.overrides(tenant), settings), 'operator');
    console.log(JSON.stringify(await store.overrides(tenant)));
  });
}
