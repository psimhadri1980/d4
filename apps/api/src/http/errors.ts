import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { CodecError } from '@d4/codecs';
import { DomainError, type DomainErrorCode } from '@d4/core';

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  VALIDATION: 422,
  INVALID_TRANSITION: 422,
  RULE_VIOLATION: 422,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  QUOTA_EXCEEDED: 403,
  LOCKED: 423,
};

interface ErrorBody {
  error: string;
  message: string;
  issues?: string[];
  ruleId?: string;
}

/** Maps any thrown value to an HTTP status and the API's error shape. */
export function toErrorResponse(e: unknown): { status: number; body: ErrorBody } {
  if (e instanceof DomainError) {
    return {
      status: DOMAIN_STATUS[e.code],
      body: {
        error: e.code,
        message: e.message,
        ...(e.issues.length && { issues: e.issues }),
        ...(e.ruleId && { ruleId: e.ruleId }),
      },
    };
  }
  // By shape as well as class: zod 3.25 ships CJS and ESM builds, and packages loaded different
  // ways (e.g. src vs dist under vitest) can see different ZodError classes.
  if (isZodError(e)) {
    return {
      status: 400,
      body: {
        error: 'BAD_REQUEST',
        message: 'Invalid request',
        issues: e.issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`),
      },
    };
  }
  if (e instanceof CodecError) {
    return { status: 400, body: { error: 'BAD_REQUEST', message: 'Invalid model document', issues: e.issues } };
  }
  // Unknown element/relationship types in query filters.
  if (e instanceof RangeError) {
    return { status: 400, body: { error: 'BAD_REQUEST', message: e.message } };
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    return { status, body: { error: httpCode(status), message: e.message } };
  }
  return { status: 500, body: { error: 'INTERNAL', message: 'Internal server error' } };
}

const HTTP_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};
const httpCode = (status: number) => HTTP_CODES[status] ?? 'ERROR';

/** The part of Fastify's reply the filter uses (fastify is not a direct dependency). */
interface Reply {
  status(code: number): { send(body: unknown): unknown };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const { status, body } = toErrorResponse(e);
    if (status >= 500) console.error(e);
    void host.switchToHttp().getResponse<Reply>().status(status).send(body);
  }
}

/** Parses input with a zod schema; failures become 400 responses via the filter. */
function isZodError(e: unknown): e is ZodError {
  return e instanceof ZodError || (e instanceof Error && e.name === 'ZodError' && Array.isArray((e as ZodError).issues));
}

export function parse<O>(schema: ZodType<O, ZodTypeDef, unknown>, input: unknown): O {
  return schema.parse(input);
}
