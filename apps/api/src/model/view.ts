import { DomainError, type ModelView } from '@d4/core';
import type { GraphQueries } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';

/**
 * Builds a model view from request values. A scenario must be a live Scenario element (or a
 * subtype) in the workspace, so a typo does not silently show the baseline.
 */
export async function resolveView(
  queries: Pick<GraphQueries, 'getElement'>,
  registry: MetamodelRegistry,
  workspaceId: string,
  v: { asOf?: string | null; scenario?: string | null },
): Promise<ModelView> {
  if (v.scenario) {
    const s = await queries.getElement(workspaceId, v.scenario);
    if (!s) throw new DomainError('NOT_FOUND', `Scenario '${v.scenario}' not found`);
    if (!registry.lineage(s.type).includes('Scenario')) {
      throw new DomainError('VALIDATION', `'${String(s.attrs['name'] ?? s.id)}' is a ${s.type}, not a Scenario`);
    }
  }
  return { asOf: v.asOf ?? null, scenarioId: v.scenario ?? null };
}
