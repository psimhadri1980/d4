import { expect, test, type Page } from '@playwright/test';
import { api, defaultWorkspaceId, openNav, RUN } from './helpers';

const search = (page: Page) => page.getByRole('search', { name: 'Find nodes' });
const result = (page: Page) => page.getByRole('region', { name: 'Result' });
const nameBox = (page: Page) => search(page).getByRole('combobox', { name: /name/i });
const card = (page: Page, name: string) => result(page).locator('.graph-canvas-node', { has: page.locator('title', { hasText: new RegExp(`^${name}$`) }) });
const nodes = (page: Page) => result(page).locator('.graph-canvas-node:not(.group)');

type Lens = { id: string; name: string };

async function saveLens(body: Record<string, unknown>): Promise<Lens> {
  const ws = await defaultWorkspaceId();
  return api<Lens>(`/v1/workspaces/${ws}/studio/lenses`, { method: 'POST', body: JSON.stringify({ visibility: 'workspace', ...body }) });
}

async function deleteLens(lens: Lens) {
  await api(`/v1/workspaces/${await defaultWorkspaceId()}/studio/lenses/${lens.id}`, { method: 'DELETE' });
}

/** Opens Graph Studio with the named lens chosen; its option label carries a summary after the name. */
async function chooseLens(page: Page, name: string) {
  await page.goto('/');
  await openNav(page, 'Graph Studio');
  const picker = search(page).getByLabel('Lens', { exact: true });
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = await picker.locator('option', { hasText: new RegExp(`^${esc} \\(`) }).first().getAttribute('value');
  await picker.selectOption(value!);
}

async function run(page: Page, text: string) {
  await nameBox(page).fill(text);
  await nameBox(page).press('Escape');
  await nameBox(page).press('Enter');
}

const labels = (page: Page) => nodes(page).evaluateAll((ns) => ns.map((n) => n.getAttribute('aria-label') ?? ''));

test.describe('lens shapes and history', () => {
  test('Keep to layers: the steps reach only node types in the ticked layers (D95)', async ({ page }) => {
    // Without layers, Client Master's neighbourhood reaches beyond the Data layer.
    await chooseLens(page, 'Data products');
    await run(page, 'Client Master');
    await expect(card(page, 'Client Master')).toBeVisible();
    await expect.poll(async () => (await labels(page)).some((l) => !l.includes(', Data'))).toBe(true);

    const lens = await saveLens({ name: `Data only ${RUN}`, contour: { type: 'DataProduct' }, layers: ['Data'], depth: 2 });
    try {
      await chooseLens(page, lens.name);
      await run(page, 'Client Master');
      await expect(card(page, 'Client Master')).toBeVisible();
      await expect.poll(async () => (await labels(page)).length).toBeGreaterThan(1);
      for (const l of await labels(page)) expect(l).toMatch(/^[^,]+, \w+, Data\b/);
    } finally {
      await deleteLens(lens);
    }
  });

  test('a time slice marks what ends or starts in its range and fades what falls outside (D97)', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    const make = (name: string, validity: Record<string, string>) =>
      api<{ id: string; version: number }>(`/v1/workspaces/${ws}/elements`, { method: 'POST', body: JSON.stringify({ type: 'DataProduct', attrs: { name }, ...validity }) });
    const made = [
      await make(`${RUN} retiring`, { validTo: '2027-03-01' }),
      await make(`${RUN} arriving`, { validFrom: '2027-06-01' }),
      await make(`${RUN} gone`, { validTo: '2026-12-01' }),
      await make(`${RUN} steady`, {}),
    ];
    const lens = await saveLens({ name: `In 2027 ${RUN}`, contour: { type: 'DataProduct' }, time: { from: '2027-01-01', to: '2028-01-01' }, depth: 1 });
    try {
      await chooseLens(page, lens.name);
      await run(page, RUN);
      await expect(card(page, `${RUN} retiring`)).toHaveAttribute('aria-label', /, Ends 2027-03$/);
      await expect(card(page, `${RUN} arriving`)).toHaveAttribute('aria-label', /, Starts 2027-06$/);
      await expect(card(page, `${RUN} gone`)).toHaveAttribute('aria-label', /, Outside$/);
      await expect(card(page, `${RUN} gone`)).toHaveClass(/mark-outside/);
      await expect(card(page, `${RUN} steady`)).toHaveAttribute('aria-label', /, root$/);

      // Changes since today: all four were made today, and that mark wins over the slice's.
      await result(page).getByLabel('Changes since').fill(new Date().toISOString().slice(0, 10));
      await expect(result(page).getByText(/\d+ changes?/)).toBeVisible();
      for (const n of ['retiring', 'arriving', 'gone', 'steady']) await expect(card(page, `${RUN} ${n}`)).toHaveAttribute('aria-label', /, Added$/);
    } finally {
      await deleteLens(lens);
      for (const m of made) await api(`/v1/workspaces/${ws}/elements/${m.id}?expectedVersion=${m.version}`, { method: 'DELETE' });
    }
  });

  test('a projection weight fills the budget with the heaviest nodes after the anchors (D96)', async ({ page }) => {
    const WEIGHTED = `MATCH (a:Application) WHERE a.workspaceId = $workspace AND a.deleted = false AND a.criticality = 'MISSION_CRITICAL'
                      OPTIONAL MATCH (a)-[:USES]->(s:DataStore) WHERE s.deleted = false
                      WITH a, collect(s) AS ss
                      UNWIND [{n: a.id, p: null, w: 0}] + [x IN ss | {n: x.id, p: a.id, w: size(x.name)}] AS row
                      RETURN row.n AS node, row.p AS parent, row.w AS weight`;
    const entry = await api<{ id: string }>('/v1/catalog', { method: 'POST', as: 'author', body: JSON.stringify({ slug: `lens-weighted-${RUN}`, title: `Weighted stores ${RUN}`, tags: ['lens'] }) });
    await api(`/v1/catalog/${entry.id}/draft`, { method: 'PUT', as: 'author', body: JSON.stringify({ cypher: WEIGHTED, params: [] }) });
    await api(`/v1/catalog/${entry.id}/submit`, { method: 'POST', as: 'author' });
    await api(`/v1/catalog/${entry.id}/review`, { method: 'POST', as: 'steward', body: JSON.stringify({ decision: 'publish' }) });
    const lens = await saveLens({ name: `Heaviest stores ${RUN}`, contour: { type: 'Application' }, query: { id: entry.id, params: {} }, disclosure: { budget: 3 } });
    try {
      // The longest-named store is the heaviest, so it is the one node kept beside the two anchors.
      const ws = await defaultWorkspaceId();
      const all = await api<{ elements: { attrs: { name: string } }[] }>(`/v1/workspaces/${ws}/studio/search`, {
        method: 'POST',
        body: JSON.stringify({ types: ['Application'], query: { id: entry.id, params: {} }, disclosure: { budget: 150, initialDepth: 1, perNodeCap: 12 } }),
      });
      const heaviest = all.elements.map((e) => e.attrs.name).sort((a, b) => b.length - a.length)[0]!;

      await chooseLens(page, lens.name);
      await search(page).getByRole('button', { name: 'Search' }).click();
      await expect(card(page, 'Core Banking System')).toHaveAttribute('aria-label', /, root$/);
      await expect(result(page).locator('.graph-canvas-node.root')).toHaveCount(2);
      await expect(nodes(page)).toHaveCount(3);
      await expect(card(page, heaviest)).toBeVisible();
    } finally {
      await deleteLens(lens);
      await api(`/v1/catalog/${entry.id}`, { method: 'DELETE', as: 'steward' });
    }
  });
});
