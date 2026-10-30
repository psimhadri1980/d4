import { QUOTA_METRICS } from './schema';
import type { Limits, QuotaMetric } from './usage';

/**
 * Applies `metric=value` settings to a tenant's limit overrides (`d4-ops quota`): a number sets
 * the limit, `unlimited` removes it, `default` returns to the built-in default.
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
