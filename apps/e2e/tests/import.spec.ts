import { expect, test } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

test.describe('spreadsheet import', () => {
  const names = [`${RUN} Sheet Gateway`, `${RUN} Sheet Ledger`];
  let ws = '';

  test.beforeAll(async () => {
    ws = await defaultWorkspaceId();
  });
  test.afterAll(async () => {
    const page = await api<{ items: { id: string; version: number; attrs: Record<string, unknown> }[] }>(
      `/v1/workspaces/${ws}/elements?q=${encodeURIComponent(RUN)}&first=200`,
    );
    for (const e of page.items.filter((x) => names.includes(String(x.attrs['name'])))) {
      await api(`/v1/workspaces/${ws}/elements/${e.id}?expectedVersion=${e.version}`, { method: 'DELETE' });
    }
  });

  test('maps a CSV, shows row problems, then imports after a successful check', async ({ page }) => {
    await page.goto(`/w/${ws}`);
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Import from spreadsheets' })).toBeVisible();

    const csv = ['Name,Criticality,Owner notes', `${names[0]},high,keep`, `${names[1]},enormous,`].join('\n');
    await page.getByLabel('Files (.csv, .xlsx)').setInputFiles({ name: 'Applications.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

    const card = page.getByRole('region', { name: 'Table Applications.csv' });
    await expect(card).toContainText('2 rows');
    await expect(card.getByLabel('Rows are')).toHaveValue('elements');
    await expect(card.getByLabel('Type for every row')).toHaveValue('Application');
    await expect(card.getByLabel('Map column Criticality')).toHaveValue('attr:criticality');
    await expect(card.getByLabel('Map column Owner notes')).toHaveValue('ignore');
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Check (dry run)' }).click();
    const result = page.getByRole('region', { name: 'Import result' });
    await expect(result.getByRole('heading', { name: '✗ Not ready' })).toBeVisible();
    await expect(result.locator('table.issues')).toContainText('"enormous" is not one of');

    // Changing the mapping clears the old check; ignoring the bad column makes it pass.
    await card.getByLabel('Map column Criticality').selectOption('ignore');
    await expect(result).toHaveCount(0);
    await page.getByRole('button', { name: 'Check (dry run)' }).click();
    await expect(result.getByRole('heading', { name: '✓ Ready to import' })).toBeVisible();
    await expect(result).toContainText('Elements: 2 new');

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(result.getByRole('heading', { name: '✓ Imported' })).toBeVisible();
    const found = await api<{ items: unknown[] }>(`/v1/workspaces/${ws}/elements?q=${encodeURIComponent(`${RUN} Sheet`)}&first=10`);
    expect(found.items).toHaveLength(2);
  });
});
