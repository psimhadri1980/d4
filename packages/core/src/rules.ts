import type { MetamodelRegistry, RuleDef } from '@d4/metamodel';
import { DomainError } from './errors';
import type { ModelReader } from './ports';
import type { Relationship } from './types';
import { overlaps } from './validity';

const rulesFor = (reg: MetamodelRegistry, relType: string): RuleDef[] =>
  reg.metamodel.rules.filter((r) => r.relationship === relType);

/**
 * Checks metamodel rules for a relationship about to be created (`isNew`) or updated.
 * Uniqueness is evaluated within the same scenario (baseline vs. baseline, scenario vs. itself).
 */
export async function assertRelationshipRules(
  reg: MetamodelRegistry,
  reader: ModelReader,
  rel: Relationship,
  isNew: boolean,
): Promise<void> {
  for (const rule of rulesFor(reg, rel.type)) {
    switch (rule.kind) {
      case 'acyclic': {
        // Endpoints never change on update, so cycles can only appear on create.
        if (!isNew) break;
        if (
          rel.fromId === rel.toId ||
          (await reader.pathExists(rel.workspaceId, rel.type, rel.toId, rel.fromId))
        ) {
          throw new DomainError(
            'RULE_VIOLATION',
            `${rel.type} from ${rel.fromId} to ${rel.toId} would create a cycle`,
            [],
            rule.id,
          );
        }
        break;
      }
      case 'uniqueValuePerTarget': {
        const value = rel.attrs[rule.attribute];
        if (typeof value !== 'string' || !rule.values.includes(value)) break;
        const clash = (await reader.relationshipsTo(rel.workspaceId, rel.type, rel.toId)).find(
          (o) =>
            o.id !== rel.id &&
            o.attrs[rule.attribute] === value &&
            o.scenarioId === rel.scenarioId &&
            overlaps(o, rel),
        );
        if (clash) {
          throw new DomainError(
            'RULE_VIOLATION',
            `${rel.toId} already has ${rel.type} with ${rule.attribute}=${value} from ${clash.fromId} in an overlapping period`,
            [],
            rule.id,
          );
        }
        break;
      }
    }
  }
}
