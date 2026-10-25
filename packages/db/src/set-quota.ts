import { loadConfig, postgres } from '@d4/config';
import { createDb } from './client';
import { QUOTA_METRICS } from './schema';
import { UsageStore, type Limits, type QuotaMetric } from './usage';

/**
 * Operator tool: changes one tenant's limits. Tenant admins can see limits but not change them.
 *
 *   node dist/set-quota.js <tenant> elements=200000 jobsPerDay=unlimited workspaces=default
 *
 * A number sets the limit, `unlimited` removes it, `default` returns to the built-in default.
 * With no settings it prints the tenant's current overrides.
 */
export function applySettings(current: Partial<Limits>, settings: string[]): Partial<Limits> {
  const next: Partial<Limits> = { ...current };
  for (const s of settings) {
    const [metric, value] = s.split('=', 2) as [string, string | undefined];
    if (!(QUOTA_METRICS as readonly string[]).includes(metric) || value === undefined) {
      throw new Error(`'${s}': expected <metric>=<number|unlimited|default>; metrics: ${QUOTA_METRICS.join(', ')}`);
    }
    const m = metric as QuotaMetric;
    if (value === 'default') delete next[m];
    else if (value === 'unlimited') next[m] = null;
    else if (/^\d+$/.test(value)) next[m] = Number(value);
    else throw new Error(`'${s}': ${value} is not a whole number`);
  }
  return next;
}

if (require.main === module) {
  const [tenant, ...settings] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: node dist/set-quota.js <tenant> [metric=value …]   (POSTGRES_URL or its parts in the environment)');
    process.exit(2);
  }
  const handle = createDb(loadConfig(postgres).POSTGRES_URL, 1);
  const store = new UsageStore(handle.db);
  (async () => {
    const current = await store.overrides(tenant);
    if (settings.length) await store.setOverrides(tenant, applySettings(current, settings), 'operator');
    console.log(JSON.stringify(await store.overrides(tenant)));
  })()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
