import { Body, Query, type PipeTransform } from '@nestjs/common';
import { parse } from './errors';
import type { z } from './zod';

/** Validates a request part with a zod schema (400 with the issues), giving handlers parsed values. */
class ZodPipe<S extends z.ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    return parse(this.schema, value);
  }
}

/** The JSON body, parsed: `@ValidBody(CreateElementBody) input: z.output<typeof CreateElementBody>`. */
export const ValidBody = (schema: z.ZodTypeAny) => Body(new ZodPipe(schema));
/** The query string, parsed with the schema. */
export const ValidQuery = (schema: z.ZodTypeAny) => Query(new ZodPipe(schema));
