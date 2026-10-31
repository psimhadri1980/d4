import type { components, paths } from './schema';

export type Schemas = components['schemas'];
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Paths that support a method. */
export type PathsWith<M extends Method> = {
  [P in keyof paths]: paths[P] extends Record<M, infer O> ? ([O] extends [never] ? never : O extends undefined ? never : P) : never;
}[keyof paths];

type Operation<P extends keyof paths, M extends Method> = NonNullable<paths[P][M & keyof paths[P]]>;
type Parameters<O> = O extends { parameters: infer X } ? X : never;
type PathParams<O> = Parameters<O> extends { path: infer X } ? ([X] extends [never] ? undefined : X) : undefined;
type QueryParams<O> = Parameters<O> extends { query?: infer X } ? ([X] extends [never] ? undefined : X) : undefined;
type JsonBody<O> = O extends { requestBody?: infer RB }
  ? [NonNullable<RB>] extends [never]
    ? undefined
    : NonNullable<RB> extends { content: { 'application/json': infer B } }
      ? B
      : undefined
  : undefined;
type JsonOf<R> = R extends { content: { 'application/json': infer B } } ? B : undefined;
type Responses<O> = O extends { responses: infer R } ? R : never;
/** The body of the operation's success response (200, 201 or 202; void for 204). */
export type Result<O> = JsonOf<Responses<O>[200 & keyof Responses<O>]> | JsonOf<Responses<O>[201 & keyof Responses<O>]> | JsonOf<Responses<O>[202 & keyof Responses<O>]>;

type Defined<T> = T extends undefined ? never : T;
/** Options for one call: `path` and `body` are required when the operation has them. */
export type CallOptions<O> = ([PathParams<O>] extends [undefined] ? { path?: undefined } : { path: Defined<PathParams<O>> }) &
  ([QueryParams<O>] extends [undefined] ? { query?: undefined } : { query?: Defined<QueryParams<O>> }) &
  ([JsonBody<O>] extends [undefined] ? { body?: undefined } : { body: Defined<JsonBody<O>> }) & { signal?: AbortSignal };

/** The API's error shape, thrown for every non-2xx response. */
export class D4ApiError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable code, e.g. VALIDATION, VERSION_CONFLICT, QUOTA_EXCEEDED, LOCKED. */
    readonly code: string,
    message: string,
    readonly issues: string[] = [],
    /** For RULE_VIOLATION the rule, for QUOTA_EXCEEDED the metric. */
    readonly ruleId?: string,
  ) {
    super(message);
    this.name = 'D4ApiError';
  }
}

export interface ClientOptions {
  /** API root behind the gateway, e.g. `https://d4.example.com/api` or `http://localhost:5173/api`. */
  baseUrl: string;
  /** A bearer token, or a function returning a fresh one (called before every request). */
  token?: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

/**
 * A typed client: paths, parameters, bodies and results are checked against the API's OpenAPI
 * document. Errors arrive as D4ApiError.
 *
 *   const d4 = createClient({ baseUrl, token });
 *   const page = await d4.get('/v1/workspaces/{ws}/elements', { path: { ws }, query: { type: 'DataProduct' } });
 */
export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call(method: Method, template: string, o: { path?: object; query?: object; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const path = template.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = (o.path as Record<string, unknown> | undefined)?.[k];
      if (v === undefined || v === null || v === '') throw new Error(`Missing path parameter '${k}' for ${template}`);
      return encodeURIComponent(String(v));
    });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));
    }
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    const res = await doFetch(`${base}${path}${qs.toString() ? `?${qs.toString()}` : ''}`, {
      method: method.toUpperCase(),
      headers: {
        accept: 'application/json',
        ...(o.body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...options.headers,
      },
      ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
      ...(o.signal && { signal: o.signal }),
    });
    if (res.status === 204) return undefined;
    const type = res.headers.get('content-type') ?? '';
    const payload: unknown = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const e = (typeof payload === 'object' && payload ? payload : {}) as { error?: string; message?: string; issues?: string[]; ruleId?: string };
      throw new D4ApiError(res.status, e.error ?? `HTTP_${res.status}`, e.message ?? (typeof payload === 'string' ? payload : res.statusText), e.issues ?? [], e.ruleId);
    }
    return payload;
  }

  const verb =
    <M extends Method>(m: M) =>
    <P extends PathsWith<M>>(path: P, ...[opts]: CallOptions<Operation<P, M>> extends { path?: undefined; body?: undefined } ? [CallOptions<Operation<P, M>>?] : [CallOptions<Operation<P, M>>]) =>
      call(m, path as string, opts as object) as Promise<Result<Operation<P, M>>>;

  return {
    get: verb('get'),
    post: verb('post'),
    put: verb('put'),
    patch: verb('patch'),
    delete: verb('delete'),
  };
}

export type D4Client = ReturnType<typeof createClient>;
