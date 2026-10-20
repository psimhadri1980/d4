import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitConfig, modelToMapped, readGitModel } from '../src';

const doc = (elements: string, relationships = '') => `apiVersion: d4/v1
kind: Model
metadata: { name: test }
elements:
${elements}
relationships:
${relationships || '  []'}
`;

/** A throwaway repository with model files on `main`. */
let repo: string;
const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
const commit = (files: Record<string, string>, message: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  sh('add', '-A');
  sh('commit', '-q', '-m', message);
  return sh('rev-parse', 'HEAD');
};
const deps = { checkUrl: async () => null, allowLocal: true };
const cfg = (extra: Partial<GitConfig> = {}) => GitConfig.parse({ url: `file://${repo}`, ...extra });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'd4-repo-'));
  sh('init', '-q', '-b', 'main');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('readGitModel', () => {
  it('reads every model file under the path at the branch head, and reports the commit', async () => {
    const head = commit(
      {
        'model/apps.yaml': doc('  - { key: crm, type: Application, name: CRM }\n  - { key: k8s, type: Platform, name: Kubernetes }', '  - { type: RUNS_ON, from: crm, to: k8s }'),
        'model/data/products.yml': doc('  - { key: client, type: DataProduct, name: Client }'),
        'model/README.md': '# not a model',
        'other/ignored.yaml': doc('  - { key: x, type: Application, name: Elsewhere }'),
      },
      'first',
    );
    const m = await readGitModel(cfg({ path: 'model' }), null, deps);
    expect(m.revision).toBe(head);
    expect(m.files).toEqual(['model/apps.yaml', 'model/data/products.yml']);
    expect(m.documents.flatMap((d) => d.elements.map((e) => e.key))).toEqual(['crm', 'k8s', 'client']);
  });

  it('refuses broken documents, missing paths and branches, escapes, and local repos outside development', async () => {
    await expect(readGitModel(cfg({ path: 'nope' }), null, deps)).rejects.toThrow(/'nope' does not exist/);
    await expect(readGitModel(cfg({ branch: 'release' }), null, deps)).rejects.toThrow(/^git: /);
    await expect(readGitModel(cfg({ path: '../..' }), null, deps)).rejects.toThrow(/outside the repository/);
    await expect(readGitModel(cfg(), null, { checkUrl: async () => null })).rejects.toThrow(/only allowed in local development/);
    await expect(readGitModel(GitConfig.parse({ url: 'https://git.example.com/r.git', auth: 'token' }), null, deps)).rejects.toThrow(/needs a token/);

    symlinkSync('/etc', join(repo, 'model', 'escape'));
    commit({ 'model/broken.yaml': 'apiVersion: d4/v1\nkind: Model\nmetadata: { name: x }\nelements: [{ type: Application }]\n' }, 'broken');
    await expect(readGitModel(cfg({ path: 'model' }), null, deps)).rejects.toThrow(/model\/broken.yaml at [0-9a-f]{8}: Invalid model document/);
  });
});

describe('modelToMapped', () => {
  it('keys elements by connector and document key, keeps own external keys, and rewrites relationship ends', () => {
    const r = modelToMapped('repo', [
      {
        apiVersion: 'd4/v1',
        kind: 'Model',
        metadata: { name: 'a' },
        elements: [
          { key: 'crm', type: 'Application', name: 'CRM', attrs: {} },
          { key: 'cmdb', type: 'Platform', name: 'K8s', attrs: { externalKey: 'cmdb:p1' } },
        ],
        relationships: [
          { type: 'RUNS_ON', from: 'crm', to: 'cmdb', attrs: {} },
          { type: 'RUNS_ON', from: 'crm', to: '01J0000000000000000000000A', attrs: {} },
        ],
      },
      { apiVersion: 'd4/v1', kind: 'Model', metadata: { name: 'b' }, elements: [{ key: 'crm', type: 'Application', name: 'Dup', attrs: {} }], relationships: [] },
    ]);
    expect(r.items.map((i) => i.externalKey)).toEqual(['repo:crm', 'cmdb:p1']);
    expect(r.items[0]!.element.attrs).toMatchObject({ name: 'CRM', externalKey: 'repo:crm' });
    expect(r.relationships.map((x) => [x.from, x.to])).toEqual([
      ['repo:crm', 'cmdb:p1'],
      ['repo:crm', '01J0000000000000000000000A'],
    ]);
    expect(r.problems).toEqual([{ record: 2, message: "duplicate key 'crm' across documents" }]);
  });
});
