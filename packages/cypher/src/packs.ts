import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { checkCatalogQuery, contentHash } from './checks';
import { paramDefIssues, type QueryParamDef } from './params';

/** A catalog query shipped with the platform, as stored in packs/<pack>/<slug>.yaml. */
export const PackQuery = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case'),
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    resultShape: z.enum(['table', 'graph']),
    /** Roles granted on installation; stewards can change grants afterwards. */
    defaultRoles: z.array(z.string()).default([]),
    params: z.array(z.unknown()).default([]),
    cypher: z.string().min(1),
  })
  .strict();

export interface SystemQuery {
  slug: string;
  title: string;
  description?: string;
  tags: string[];
  resultShape: 'table' | 'graph';
  defaultRoles: string[];
  params: QueryParamDef[];
  cypher: string;
  contentHash: string;
  /** Static-check warnings (errors make loading fail). */
  warnings: string[];
}

export const PACKS_DIR = join(__dirname, '..', 'packs');

/** Parses and checks one pack query; throws with every problem found. */
export function parsePackQuery(text: string, source = '<inline>'): SystemQuery {
  const parsed = PackQuery.safeParse(parse(text));
  if (!parsed.success) {
    throw new Error(`${source}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const q = parsed.data;
  const { defs, issues } = paramDefIssues(q.params);
  const checks = checkCatalogQuery(q.cypher, defs);
  const problems = [...issues, ...checks.errors];
  if (problems.length) throw new Error(`${source}: ${problems.join('; ')}`);
  const cypher = q.cypher.trimEnd();
  return {
    slug: q.slug,
    title: q.title,
    ...(q.description && { description: q.description.trim() }),
    tags: q.tags,
    resultShape: q.resultShape,
    defaultRoles: q.defaultRoles,
    params: defs,
    cypher,
    contentHash: contentHash({ cypher, params: defs, resultShape: q.resultShape, kind: 'read' }),
    warnings: checks.warnings,
  };
}

/** Loads every query of a pack directory (default: the built-in `system` pack), sorted by slug. */
export function loadPack(name = 'system', dir = PACKS_DIR): SystemQuery[] {
  const base = join(dir, name);
  return readdirSync(base)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const q = parsePackQuery(readFileSync(join(base, f), 'utf8'), `${name}/${f}`);
      if (`${q.slug}.yaml` !== f) throw new Error(`${name}/${f}: slug '${q.slug}' must match the file name`);
      return q;
    });
}
