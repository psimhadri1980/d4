import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { api, defaultWorkspaceId } from './helpers';

async function downloadFromJobs(page: Page, rowText: RegExp) {
  await page.getByRole('link', { name: 'See Jobs' }).click();
  const row = page.getByRole('table', { name: 'Jobs' }).locator('tr.job', { hasText: rowText }).first();
  await expect(row.locator('.badge')).toHaveText('succeeded', { timeout: 45_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: /^Download/ }).click()]);
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

test.describe('pictures', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('the Roadmap page renders a PDF in the background', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roadmap' }).click();
    await page.getByRole('checkbox', { name: 'Client Data Consolidation' }).check();
    await expect(page.getByLabel('Roadmap summary')).toContainText('8 items');
    await page.getByRole('group', { name: 'Picture' }).getByRole('button', { name: 'PDF' }).click();
    const pdf = await downloadFromJobs(page, /Picture \(PDF\) of a roadmap/);
    expect(pdf.name).toBe('roadmap-client-data-consolidation.pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.bytes.length).toBeGreaterThan(5_000);
  });

  test('the Explorer renders the graph on screen as PNG', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    const found = await api<{ items: { id: string; attrs: Record<string, unknown> }[] }>(`/v1/workspaces/${ws}/elements?q=Client%20Master&first=5`);
    const client = found.items.find((e) => e.attrs['name'] === 'Client Master')!;
    await page.goto(`/w/${ws}/e/${client.id}`);
    const menu = page.getByRole('group', { name: 'Export' });
    await menu.getByLabel('Export', { exact: true }).selectOption('picture:png');
    await menu.getByRole('button', { name: 'Start' }).click();
    const png = await downloadFromJobs(page, /Picture \(PNG\) of a graph/);
    expect(png.name).toBe('client-master.png');
    expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
    // Rendered at 2× pixel density: wider than the 640 px minimum picture.
    expect(png.bytes.readUInt32BE(16)).toBeGreaterThan(1280);
  });
});
