import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { ErrorSchema, z } from './zod';

/** Registers one OpenAPI path (bearer auth unless the route says otherwise). */
export type ApiRoute = (r: RouteConfig) => void;

export const json = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
export const errors = {
  400: json(ErrorSchema, 'Malformed request'),
  401: json(ErrorSchema, 'Missing or invalid token'),
  403: json(ErrorSchema, 'No access to the workspace'),
  404: json(ErrorSchema, 'Not found'),
};
export const writeErrors = {
  ...errors,
  409: json(ErrorSchema, 'Version conflict (re-read and retry)'),
  422: json(ErrorSchema, 'Metamodel, lifecycle or rule violation'),
};

export const ws = z.string().openapi({ param: { name: 'ws', in: 'path' } });
export const id = z.string().openapi({ param: { name: 'id', in: 'path' } });
