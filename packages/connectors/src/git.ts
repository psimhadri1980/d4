import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Attributes, ImportRelationship } from '@d4/core';
import { CodecError, parseModelDocument, toImportInput, type ModelDocument } from '@d4/codecs';
import { z } from 'zod';
import type { MappedItem, MappingResult } from './mapping';
import { SourceError, type SourceDeps } from './source-error';

export const GitConfig = z
  .object({
    /** https://host/org/repo.git (http and file:// only where private addresses are allowed: local development). */
    url: z.string().min(1),
    branch: z.string().regex(/^[A-Za-z0-9._/-]+$/).default('main'),
    /** A YAML/JSON model file, or a directory searched recursively; empty for the whole repository. */
    path: z.string().regex(/^[A-Za-z0-9._/-]*$/).default(''),
    /** `token`: the secret is a token sent with HTTP basic auth (GitHub, GitLab, Azure Repos accept this). */
    auth: z.enum(['none', 'token']).default('none'),
    username: z.string().default('x-access-token'),
  })
  .strict();
export type GitConfig = z.infer<typeof GitConfig>;

const TIMEOUT_MS = 60_000;
const MAX_FILES = 200;
const MAX_BYTES = 20 * 1024 * 1024;

function git(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return done(stdout.trim());
      // Never echo the environment (it carries the token); git's own message is enough.
      const msg = (stderr || err.message).split('\n').filter((l) => l && !/authorization/i.test(l)).slice(-2).join(' ');
      fail(new SourceError((err as { killed?: boolean }).killed ? `git did not finish within ${TIMEOUT_MS / 1000} s` : `git: ${msg}`));
    });
  });
}

export interface GitModel {
  /** Commit the documents were read from. */
  revision: string;
  files: string[];
  documents: ModelDocument[];
}

/**
 * Reads model-as-code documents from one branch of a Git repository: a shallow clone into a
 * temporary directory (removed afterwards), then every .yaml/.yml/.json file under `path`. Any
 * invalid document fails the read, so a sync never applies part of a broken change.
 */
export async function readGitModel(config: GitConfig, secret: string | null, deps: SourceDeps & { allowLocal?: boolean }): Promise<GitModel> {
  const isFile = config.url.startsWith('file://');
  if (isFile && !deps.allowLocal) throw new SourceError('file:// repositories are only allowed in local development');
  if (!isFile) {
    const bad = await deps.checkUrl(config.url);
    if (bad) throw new SourceError(`Repository URL ${bad}`);
  }
  if (config.auth === 'token' && !secret) throw new SourceError('The connector needs a token secret');

  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: tmpdir(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    // Only the transports this URL needs; never ext:: or other helpers.
    GIT_ALLOW_PROTOCOL: isFile ? 'file' : deps.allowLocal ? 'https:http' : 'https',
    ...(config.auth === 'token' && secret
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${config.username}:${secret}`).toString('base64')}` }
      : {}),
  };
  const dir = await mkdtemp(join(tmpdir(), 'd4-git-'));
  try {
    await git(['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', config.branch, '--', config.url, dir], env);
    const revision = await git(['rev-parse', 'HEAD'], env, dir);
    const root = await realpath(dir);
    const start = resolve(root, config.path || '.');
    if (start !== root && !start.startsWith(root + sep)) throw new SourceError(`path '${config.path}' is outside the repository`);

    const files: string[] = [];
    let bytes = 0;
    const visit = async (p: string): Promise<void> => {
      const st = await lstat(p).catch(() => undefined);
      if (!st) throw new SourceError(`'${relative(root, p) || config.path}' does not exist on ${config.branch}`);
      if (st.isSymbolicLink()) return; // never follow links out of the clone
      if (st.isDirectory()) {
        if (p.endsWith(`${sep}.git`)) return;
        for (const name of (await readdir(p)).sort()) await visit(join(p, name));
        return;
      }
      if (!/\.(ya?ml|json)$/i.test(p)) return;
      bytes += st.size;
      if (files.length >= MAX_FILES) throw new SourceError(`more than ${MAX_FILES} model files under '${config.path || '/'}'`);
      if (bytes > MAX_BYTES) throw new SourceError(`model files under '${config.path || '/'}' exceed ${MAX_BYTES / 1024 / 1024} MB`);
      files.push(p);
    };
    await visit(start);
    if (!files.length) throw new SourceError(`no .yaml, .yml or .json files under '${config.path || '/'}' on ${config.branch}`);

    const documents: ModelDocument[] = [];
    for (const f of files) {
      try {
        documents.push(parseModelDocument(await readFile(f, 'utf8')));
      } catch (e) {
        const why = e instanceof CodecError ? e.message : String(e);
        throw new SourceError(`${relative(root, f)} at ${revision.slice(0, 8)}: ${why}`);
      }
    }
    return { revision, files: files.map((f) => relative(root, f)), documents };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/**
 * Model documents → sync items. Elements keep their own `externalKey` if they have one, otherwise
 * get `<connector key>:<document key>`; keys must be unique across all documents of the sync.
 * Relationship ends that are document keys are rewritten to those external keys; anything else
 * (an existing element id) is passed on as is.
 */
export function modelToMapped(connectorKey: string, documents: ModelDocument[]): MappingResult {
  const items: MappedItem[] = [];
  const relationships: ImportRelationship[] = [];
  const problems: MappingResult['problems'] = [];
  const keyMap = new Map<string, string>();
  let index = 0;
  for (const doc of documents) {
    const input = toImportInput(doc);
    for (const e of input.elements) {
      const ext = typeof e.attrs['externalKey'] === 'string' ? (e.attrs['externalKey'] as string) : `${connectorKey}:${e.key}`;
      if (keyMap.has(e.key)) {
        problems.push({ record: index++, message: `duplicate key '${e.key}' across documents` });
        continue;
      }
      keyMap.set(e.key, ext);
      const attrs: Attributes = { ...e.attrs, externalKey: ext };
      const element = { ...e, key: ext, attrs };
      items.push({ externalKey: ext, element, hash: createHash('sha256').update(stable({ type: e.type, attrs, validFrom: e.validFrom ?? null, validTo: e.validTo ?? null, scenarioId: e.scenarioId ?? null })).digest('hex').slice(0, 32) });
      index++;
    }
    for (const r of input.relationships) relationships.push(r);
  }
  return {
    items,
    relationships: relationships.map((r) => ({ ...r, from: keyMap.get(r.from) ?? r.from, to: keyMap.get(r.to) ?? r.to })),
    problems,
  };
}
