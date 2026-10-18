import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

test.describe('background jobs', () => {
  test.describe.configure({ mode: 'serial' });
  const name = `${RUN} Queued Platform`;
  let ws = '';
  test.beforeAll(async () => {
    ws = await defaultWorkspaceId();
  });
  test.afterAll(async () => {
    const found = await api<{ items: { id: string; version: number; attrs: Record<string, unknown> }[] }>(
      `/v1/workspaces/${ws}/elements?q=${encodeURIComponent(name)}&first=10`,
    );
    for (const e of found.items.filter((x) => x.attrs['name'] === name)) {
      await api(`/v1/workspaces/${ws}/elements/${e.id}?expectedVersion=${e.version}`, { method: 'DELETE' });
    }
  });

  test('an export runs in the background and is downloaded from Jobs', async ({ page }) => {
    await page.goto(`/w/${ws}`);
    const menu = page.getByRole('group', { name: 'Export' });
    await menu.getByLabel('Export', { exact: true }).selectOption('archimate');
    await menu.getByLabel('What to export').selectOption({ label: 'Whole workspace' });
    await menu.getByLabel('In background').check();
    await menu.getByRole('button', { name: 'Start' }).click();
    await menu.getByRole('link', { name: 'See Jobs' }).click();

    const row = page.getByRole('table', { name: 'Jobs' }).locator('tr.job').first();
    await expect(row).toContainText('Export archimate of the workspace');
    await expect(row.locator('.badge')).toHaveText('succeeded', { timeout: 20_000 });
    await expect(row).toContainText(/\d+ elements, \d+ relationships/);
    const [file] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: /^Download/ }).click()]);
    expect(file.suggestedFilename()).toBe('default.archimate.xml');
    expect(await readFile((await file.path())!, 'utf8')).toContain('<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/"');
  });

  test('a spreadsheet import can run in the background after a check', async ({ page }) => {
    await page.goto(`/w/${ws}/import`);
    await page.getByLabel('Files (.csv, .xlsx)').setInputFiles({ name: 'Platforms.csv', mimeType: 'text/csv', buffer: Buffer.from(`Name,platformType\n${name},streaming\n`) });
    await expect(page.getByRole('region', { name: 'Table Platforms.csv' })).toBeVisible();
    await page.getByRole('button', { name: 'Check (dry run)' }).click();
    await expect(page.getByRole('heading', { name: '✓ Ready to import' })).toBeVisible();
    await page.getByLabel('In background (large files)').check();
    await page.getByRole('button', { name: 'Import in background' }).click();
    await page.getByRole('link', { name: 'See Jobs' }).click();

    const row = page.getByRole('table', { name: 'Jobs' }).locator('tr.job', { hasText: 'Import Platforms.csv' }).first();
    await expect(row.locator('.badge')).toHaveText('succeeded', { timeout: 20_000 });
    await expect(row).toContainText('Imported: 1 new');
    const found = await api<{ items: unknown[] }>(`/v1/workspaces/${ws}/elements?q=${encodeURIComponent(name)}&first=5`);
    expect(found.items).toHaveLength(1);
  });
});
