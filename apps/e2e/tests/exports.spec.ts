import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { api, defaultWorkspaceId } from './helpers';

async function download(page: Page, format: string, what: 'This graph' | 'Whole workspace') {
  const menu = page.getByRole('group', { name: 'Export' });
  await menu.getByLabel('Export', { exact: true }).selectOption(format);
  await menu.getByLabel('What to export').selectOption({ label: what });
  const [file] = await Promise.all([page.waitForEvent('download'), menu.getByRole('button', { name: 'Download' }).click()]);
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}

test.describe('exports', () => {
  test('exports the graph on screen as Mermaid and the workspace as ArchiMate', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    const page1 = await api<{ items: { id: string; attrs: Record<string, unknown> }[] }>(`/v1/workspaces/${ws}/elements?q=Client%20Master&first=5`);
    const client = page1.items.find((e) => e.attrs['name'] === 'Client Master')!;
    await page.goto(`/w/${ws}/e/${client.id}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Client Master' })).toBeVisible();

    const mmd = await download(page, 'mermaid', 'This graph');
    expect(mmd.name).toBe('default.mmd');
    expect(mmd.text).toContain('flowchart LR');
    expect(mmd.text).toContain('Client Master');
    // Depth 1 only: an element two hops away is not in the file.
    expect(mmd.text).not.toContain('Core Banking System');

    const xml = await download(page, 'archimate', 'Whole workspace');
    expect(xml.name).toBe('default.archimate.xml');
    expect(xml.text).toContain('<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/"');
    expect(xml.text).toContain('Core Banking System');
  });

  test('follows the as-of date', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    const page1 = await api<{ items: { id: string; attrs: Record<string, unknown> }[] }>(`/v1/workspaces/${ws}/elements?q=Client%20Master&first=5`);
    const client = page1.items.find((e) => e.attrs['name'] === 'Client Master')!;
    await page.goto(`/w/${ws}/e/${client.id}`);
    await page.getByLabel('As of').fill('2027-08-01');
    const csv = await download(page, 'relationships-csv', 'This graph');
    expect(csv.name).toBe('default-2027-08-01.relationships.csv');
    expect(csv.text).toContain('REPLICA');
    expect(csv.text).not.toContain('GOLDEN_COPY');
    await page.getByRole('group', { name: 'Model view' }).getByRole('button', { name: 'Reset' }).click();
  });
});
