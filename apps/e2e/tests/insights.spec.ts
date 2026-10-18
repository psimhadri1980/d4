import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { defaultWorkspaceId } from './helpers';

const cell = (page: Page, row: string, column: string, values: string) => page.locator(`td[title="${row} · ${column}: ${values}"]`);

test.describe('matrices', () => {
  let ws = '';
  test.beforeAll(async () => {
    ws = await defaultWorkspaceId();
  });

  test('CRUD-I matrix groups steps by process and exports CSV', async ({ page }) => {
    await page.goto(`/w/${ws}/matrices`);
    await expect(page.getByRole('link', { name: 'Matrices' })).toHaveAttribute('aria-current', 'page');
    const table = page.getByRole('table', { name: 'CRUD-I matrix' });
    await expect(table.locator('.group-row', { hasText: 'Client Onboarding' })).toBeVisible();
    await expect(cell(page, 'Capture client details', 'Client Master', 'CREATE')).toHaveText('C');
    await expect(page.getByRole('list', { name: 'Legend' })).toContainText('inactivate');

    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(csv.suggestedFilename()).toBe('crud.csv');
    const text = await readFile((await csv.path())!, 'utf8');
    expect(text.split('\n')[0]).toMatch(/^group,Process step,/);
    expect(text).toContain('Client Onboarding,Capture client details,');
  });

  test('data store roles follow the as-of date', async ({ page }) => {
    await page.goto(`/w/${ws}/matrices?kind=data-store-roles`);
    await page.getByLabel('As of').fill('2027-01-01');
    await expect(cell(page, 'Client MDM Hub', 'Client Master', 'GOLDEN_COPY')).toHaveText('GC');
    await page.getByLabel('As of').fill('2027-08-01');
    await expect(cell(page, 'Client MDM Hub', 'Client Master', 'MASTER')).toHaveText('M');
    await expect(cell(page, 'Legacy Client Database', 'Client Master', 'REPLICA')).toHaveText('R');
    await page.getByRole('group', { name: 'Model view' }).getByRole('button', { name: 'Reset' }).click();
    // Without a date, both periods show and the planned hand-over is not flagged.
    await expect(cell(page, 'Client MDM Hub', 'Client Master', 'MASTER, GOLDEN_COPY')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Findings' })).not.toContainText('more than one master');
  });

  test('capability × application and the lifecycle heat-map', async ({ page }) => {
    await page.goto(`/w/${ws}/matrices`);
    await page.getByRole('group', { name: 'Matrix' }).getByRole('button', { name: 'Capability × application' }).click();
    await expect(page).toHaveURL(/kind=capability-application/);
    await expect(page.getByRole('table', { name: 'Capability × application' })).toBeVisible();
    await page.getByRole('group', { name: 'Matrix' }).getByRole('button', { name: 'Lifecycle' }).click();
    const heat = page.getByRole('table', { name: 'Lifecycle heat-map' });
    await expect(heat.getByRole('columnheader', { name: 'LIVE' })).toBeVisible();
    await expect(heat.locator('td[title^="Application · LIVE: "]')).not.toHaveText('');
  });
});

test.describe('decisions', () => {
  test('the log shows the sample ADR with its options and decided elements', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    await page.goto(`/w/${ws}/decisions`);
    const record = page.getByRole('article', { name: 'Decision record' });
    await expect(record.getByRole('heading', { name: 'Client MDM Hub becomes master for client data' })).toBeVisible();
    await expect(record).toContainText('decided 2026-09-15');
    await expect(record.locator('li.chosen')).toContainText('Introduce a dedicated client MDM hub');
    await expect(record.getByRole('link', { name: 'Legacy Client Database', exact: true })).toBeVisible();

    await page.getByLabel('Status').selectOption('REJECTED');
    await expect(page.getByText('No decisions match.')).toBeVisible();
    await page.getByLabel('Status').selectOption('');
    await page.getByLabel('Search').fill('legacy client');
    await expect(page.getByRole('list', { name: 'Decision log' }).getByRole('button')).toHaveCount(1);

    await page.getByRole('link', { name: '+ New decision' }).click();
    await expect(page).toHaveURL(/\/new\?type=Decision$/);
    await expect(page.getByLabel(/^Type/)).toHaveValue('Decision');
  });
});
