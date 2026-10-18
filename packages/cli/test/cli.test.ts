import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../src';

const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');

function harness(responses: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const files = new Map<string, string>();
  const io: CliIO = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    env: { D4_API_URL: 'http://api.test', D4_TOKEN: 'tok' },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const body = responses[path];
      // Strings are file bodies (exports); everything else is JSON.
      return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? { error: 'NOT_FOUND', message: 'nope' }), {
        status: body ? 200 : 404,
      });
    }) as typeof fetch,
    readFile: async (p) => files.get(p) ?? readFileSync(p, 'utf8'),
    writeFile: async (p, t) => void files.set(p, t),
  };
  return { io, out, err, calls, files };
}

describe('d4 validate', () => {
  it('accepts the UBS sample', async () => {
    const h = harness();
    expect(await runCli(['validate', SAMPLE], h.io)).toBe(0);
    expect(h.out.join('')).toMatch(/is valid for d4-starter@0\.2\.0/);
  });

  it('fails with issues for a broken document', async () => {
    const h = harness();
    h.files.set(
      'bad.yaml',
      'apiVersion: d4/v1\nkind: Model\nmetadata: { name: t }\nelements: [{ key: a, type: Nope, name: x }]',
    );
    expect(await runCli(['validate', 'bad.yaml'], h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/unknown element type 'Nope'/);
  });

  it('reports missing files cleanly', async () => {
    const h = harness();
    expect(await runCli(['validate', '/no/such/file.yaml'], h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/error: .*ENOENT/);
  });
});

describe('d4 import / export', () => {
  const workspaces = { '/v1/workspaces': [{ id: 'WS1', slug: 'default', name: 'Default' }] };

  it('resolves the workspace slug and posts the document', async () => {
    const h = harness({
      ...workspaces,
      '/v1/workspaces/WS1/import': {
        ok: true,
        applied: false,
        issues: [],
        elements: { created: 2, updated: 0, unchanged: 0 },
        relationships: { created: 1, updated: 0, unchanged: 0 },
      },
    });
    expect(await runCli(['import', SAMPLE, '-w', 'default', '--dry-run'], h.io)).toBe(0);
    const post = h.calls.find((c) => c.url.includes('/import'))!;
    expect(post.url).toBe('http://api.test/v1/workspaces/WS1/import?dryRun=true');
    expect((post.init!.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(h.out.join('')).toMatch(/dry run: valid/);
  });

  it('says when an import changed nothing', async () => {
    const h = harness({
      ...workspaces,
      '/v1/workspaces/WS1/import': {
        ok: true,
        applied: false,
        issues: [],
        elements: { created: 0, updated: 0, unchanged: 2 },
        relationships: { created: 0, updated: 0, unchanged: 1 },
      },
    });
    expect(await runCli(['import', SAMPLE, '-w', 'default'], h.io)).toBe(0);
    expect(h.out.join('')).toMatch(/already up to date/);
  });

  it('writes exports as YAML', async () => {
    const h = harness({
      ...workspaces,
      '/v1/workspaces/WS1/export': {
        apiVersion: 'd4/v1',
        kind: 'Model',
        metadata: { name: 'Default' },
        elements: [{ key: 'platform-k8s', type: 'Platform', name: 'K8s', attrs: {} }],
        relationships: [],
      },
    });
    expect(await runCli(['export', '-w', 'WS1', '-o', 'out.yaml'], h.io)).toBe(0);
    expect(h.files.get('out.yaml')).toMatch(/key: platform-k8s/);
  });

  it('exports other formats as files, passing view and scope', async () => {
    const h = harness({ ...workspaces, '/v1/workspaces/WS1/export': 'flowchart LR\n  n1["K8s"]\n' });
    expect(await runCli(['export', '-w', 'WS1', '--format', 'mermaid', '--as-of', '2027-01-01', '--scope', 'A,B', '-o', 'g.mmd'], h.io)).toBe(0);
    expect(h.files.get('g.mmd')).toBe('flowchart LR\n  n1["K8s"]\n');
    const url = new URL(h.calls.at(-1)!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ asOf: '2027-01-01', scope: 'A,B', format: 'mermaid' });
    expect(await runCli(['export', '-w', 'WS1', '--format', 'pdf'], h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/unknown format 'pdf' \(one of: yaml, json, elements-csv/);
  });

  it('needs a token for API commands', async () => {
    const h = harness(workspaces);
    h.io.env = {};
    expect(await runCli(['workspaces'], h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/D4_TOKEN is not set/);
  });
});
