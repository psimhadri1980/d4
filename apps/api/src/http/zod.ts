import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds `.openapi()` to zod schemas; must run before any schema is defined, so every schema imports z from here.
extendZodWithOpenApi(z);

export { z };

export const ErrorSchema = z
  .object({
    error: z.string().openapi({
      example: 'RULE_VIOLATION',
      description: 'BAD_REQUEST | VALIDATION | NOT_FOUND | VERSION_CONFLICT | INVALID_TRANSITION | RULE_VIOLATION',
    }),
    message: z.string(),
    issues: z.array(z.string()).optional(),
    ruleId: z.string().optional(),
  })
  .openapi('Error');
