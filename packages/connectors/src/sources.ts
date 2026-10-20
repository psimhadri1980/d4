import { z } from 'zod';
import { readGitModel, GitConfig, modelToMapped } from './git';
import { get, type MappingResult } from './mapping';
import { SourceError, type SourceDeps } from './source-error';

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const HttpJsonConfig = z
  .object({
    url: z.string().url(),
    /** `bearer`: the secret is a token. `basic`: the secret is `user:password`. */
    auth: z.enum(['none', 'bearer', 'basic']).default('none'),
    /** Non-secret extra headers, e.g. Accept variants. */
    headers: z.record(z.string()).default({}),
    /** Where the next page's URL is in each response; absent means one page. */
    nextPath: z.string().optional(),
    maxPages: z.number().int().min(1).max(500).default(50),
  })
  .strict();
export type HttpJsonConfig = z.infer<typeof HttpJsonConfig>;

function authHeader(auth: HttpJsonConfig['auth'], secret: string | null): Record<string, string> {
  if (auth === 'none') return {};
  if (!secret) throw new SourceError(`The connector needs a ${auth === 'bearer' ? 'token' : 'user:password'} secret`);
  return { authorization: auth === 'bearer' ? `Bearer ${secret}` : `Basic ${Buffer.from(secret).toString('base64')}` };
}

/**
 * Reads every record from a JSON HTTP API: follows `nextPath` links (relative or absolute) up to
 * `maxPages`, takes records from `itemsPath`, and refuses oversized, slow or non-JSON responses.
 */
export async function fetchJsonRecords(config: HttpJsonConfig, secret: string | null, itemsPath: string, deps: SourceDeps): Promise<{ records: unknown[]; pages: number }> {
  const doFetch = deps.fetch ?? fetch;
  const headers = { accept: 'application/json', 'user-agent': 'D4-Connectors/1', ...config.headers, ...authHeader(config.auth, secret) };
  const records: unknown[] = [];
  const seen = new Set<string>();
  let url: string | undefined = config.url;
  let pages = 0;
  while (url && pages < config.maxPages) {
    if (seen.has(url)) break;
    seen.add(url);
    const bad = await deps.checkUrl(url);
    if (bad) throw new SourceError(`Source URL ${bad}`);
    let res: Response;
    try {
      res = await doFetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new SourceError(e instanceof Error && e.name === 'TimeoutError' ? `no response within ${TIMEOUT_MS / 1000} s from ${url}` : `cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new SourceError(`${url} answered HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new SourceError(`${url} sent ${length} bytes; the limit is ${MAX_BYTES}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new SourceError(`${url} sent more than ${MAX_BYTES} bytes`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SourceError(`${url} did not answer with JSON`);
    }
    const items = get(body, itemsPath);
    if (!Array.isArray(items)) throw new SourceError(`No list of records at '${itemsPath || '(the response)'}' in ${url}`);
    records.push(...items);
    pages++;
    const next = config.nextPath ? get(body, config.nextPath) : undefined;
    url = typeof next === 'string' && next ? new URL(next, url).toString() : undefined;
  }
  return { records, pages };
}

/**
 * A kind of connector. `records` kinds fetch source records that a mapping turns into elements;
 * `model` kinds read D4 model documents, which need no mapping.
 */
export type ConnectorKind =
  | {
      mode: 'records';
      name: string;
      description: string;
      config: z.ZodTypeAny;
      fetch(config: unknown, secret: string | null, itemsPath: string, deps: SourceDeps): Promise<{ records: unknown[]; pages: number }>;
    }
  | {
      mode: 'model';
      name: string;
      description: string;
      config: z.ZodTypeAny;
      load(config: unknown, secret: string | null, connectorKey: string, deps: SourceDeps & { allowLocal?: boolean }): Promise<{ mapped: MappingResult; revision: string; files: string[] }>;
    };

export const CONNECTOR_KINDS: Record<string, ConnectorKind> = {
  'http-json': {
    mode: 'records',
    name: 'HTTP JSON',
    description: 'Any JSON API: a URL, optional bearer or basic auth, and link-based paging.',
    config: HttpJsonConfig,
    fetch: (config, secret, itemsPath, deps) => fetchJsonRecords(HttpJsonConfig.parse(config), secret, itemsPath, deps),
  },
  git: {
    mode: 'model',
    name: 'Git model-as-code',
    description: 'D4 model documents (YAML/JSON) on a branch of a Git repository; each sync records the commit.',
    config: GitConfig,
    load: async (config, secret, connectorKey, deps) => {
      const model = await readGitModel(GitConfig.parse(config), secret, deps);
      return { mapped: modelToMapped(connectorKey, model.documents), revision: model.revision, files: model.files };
    },
  },
};
