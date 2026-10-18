import { z } from 'zod';

/** Parameters the platform supplies on every run; catalog queries must not declare them. */
export const SYSTEM_PARAMS = ['workspace'] as const;

const ParamName = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'must be camelCase');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const QueryParamDef = z
  .object({
    name: ParamName,
    type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'enum', 'element', 'string[]']),
    label: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    /** Allowed values for `enum`. */
    values: z.array(z.string()).optional(),
    /** For `element`: types offered by the picker (supertypes include subtypes). */
    elementTypes: z.array(z.string()).optional(),
  })
  .strict();
export type QueryParamDef = z.infer<typeof QueryParamDef>;

/** Validates a version's parameter definitions; returns problems as messages. */
export function paramDefIssues(raw: unknown): { defs: QueryParamDef[]; issues: string[] } {
  const parsed = z.array(QueryParamDef).safeParse(raw);
  if (!parsed.success) {
    return {
      defs: [],
      issues: parsed.error.issues.map((i) => `params.${i.path.join('.')}: ${i.message}`),
    };
  }
  const defs = parsed.data;
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.name)) issues.push(`parameter '${d.name}' is declared twice`);
    seen.add(d.name);
    if ((SYSTEM_PARAMS as readonly string[]).includes(d.name)) {
      issues.push(`parameter '${d.name}' is supplied by the platform and cannot be declared`);
    }
    if (d.type === 'enum' && !d.values?.length) issues.push(`enum parameter '${d.name}' needs values`);
    if (d.default !== undefined) {
      const err = valueIssue(d, d.default);
      if (err) issues.push(`default of '${d.name}' ${err}`);
    }
  }
  return { defs, issues };
}

function valueIssue(d: QueryParamDef, v: unknown): string | undefined {
  switch (d.type) {
    case 'string':
      return typeof v === 'string' ? undefined : 'must be a string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? undefined : 'must be a number';
    case 'integer':
      return Number.isInteger(v) ? undefined : 'must be an integer';
    case 'boolean':
      return typeof v === 'boolean' ? undefined : 'must be true or false';
    case 'date':
      return typeof v === 'string' && ISO_DATE.test(v) && !isNaN(Date.parse(v)) ? undefined : 'must be YYYY-MM-DD';
    case 'enum':
      return typeof v === 'string' && d.values?.includes(v) ? undefined : `must be one of ${d.values?.join(', ')}`;
    case 'element':
      return typeof v === 'string' && ULID.test(v) ? undefined : 'must be an element id';
    case 'string[]':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? undefined : 'must be a list of strings';
  }
}

/**
 * Checks run-time values against the definitions: applies defaults, rejects unknown names and
 * wrong types. Numbers arriving as strings (query strings, forms) are converted.
 */
export function bindParams(
  defs: QueryParamDef[],
  input: Record<string, unknown>,
): { values: Record<string, unknown>; issues: string[] } {
  const values: Record<string, unknown> = {};
  const issues: string[] = [];
  const known = new Set(defs.map((d) => d.name));
  for (const k of Object.keys(input)) if (!known.has(k)) issues.push(`unknown parameter '${k}'`);

  for (const d of defs) {
    let v = input[d.name];
    if (v === undefined || v === null || v === '') v = d.default;
    if (v === undefined) {
      if (d.required) issues.push(`parameter '${d.name}' is required`);
      else values[d.name] = null;
      continue;
    }
    if ((d.type === 'number' || d.type === 'integer') && typeof v === 'string' && v.trim() !== '') v = Number(v);
    if (d.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
    const err = valueIssue(d, v);
    if (err) issues.push(`parameter '${d.name}' ${err}`);
    else values[d.name] = v;
  }
  return { values, issues };
}
