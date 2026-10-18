import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.describe('roadmap studio', () => {
  test('schedules an initiative with lanes, critical path and conflicts', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roadmap' }).click();
    await expect(page.getByRole('link', { name: 'Roadmap' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/Choose an initiative/)).toBeVisible();

    await page.getByRole('checkbox', { name: 'Client Data Consolidation' }).check();
    await expect(page).toHaveURL(/scope=/);
    const summary = page.getByLabel('Roadmap summary');
    await expect(summary).toContainText('2026-10-01 → 2027-12-31');
    await expect(summary).toContainText('8 items');
    await expect(summary).toContainText('2 conflicts');

    const gantt = page.getByRole('img', { name: /Gantt chart with 8 items/ });
    await expect(gantt.getByRole('button', { name: /Decommission legacy client database.*critical/ })).toBeVisible();
    await expect(gantt.getByRole('button', { name: /Migrate client master.*has conflicts/ })).toBeVisible();
    await expect(gantt.locator('.gantt-lane-label')).toHaveText(['Client Data Consolidation', 'Milestones']);

    // Picking a conflict selects the item and shows planned vs earliest dates.
    await page.getByRole('region', { name: 'Conflicts' }).getByRole('button', { name: /Planned too early/ }).click();
    const details = page.getByLabel('Selected item');
    await expect(details.getByRole('heading', { name: 'Migrate client master to MDM Hub' })).toBeVisible();
    await expect(details).toContainText('2027-04-01 → 2027-06-30');
    await expect(details).toContainText('2027-05-01 → 2027-07-30');
    await expect(details.getByRole('link', { name: 'Client Master' })).toBeVisible();

    // Following a dependency moves the selection.
    await details.getByRole('button', { name: 'Build Client MDM Hub' }).click();
    await expect(details.getByRole('heading', { name: 'Build Client MDM Hub' })).toBeVisible();
  });

  test('regroups lanes, zooms, survives reload and exports', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roadmap' }).click();
    await page.getByLabel('Any element').fill('Legacy Client Database');
    await page.getByRole('list', { name: 'Search results' }).getByRole('button', { name: /Legacy Client Database/ }).click();
    await expect(page.getByRole('list', { name: 'Selected scope' })).toContainText('Legacy Client Database');
    await expect(page.getByLabel('Roadmap summary')).toContainText('2 items');

    await page.getByLabel('Lanes by').selectOption('status');
    await page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: 'Quarter' }).click();
    await expect(page.locator('.gantt-lane-label')).toHaveText(['Milestones', 'NOT_STARTED']);
    await page.reload();
    await expect(page.getByLabel('Lanes by')).toHaveValue('status');
    await expect(page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: 'Quarter' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.gantt-axis-label').first()).toHaveText(/^Q\d \d{4}$/);

    const [mermaid] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Mermaid' }).click()]);
    expect(mermaid.suggestedFilename()).toBe('roadmap.mmd');
    const text = await readFile((await mermaid.path())!, 'utf8');
    expect(text).toMatch(/^gantt\n/);
    expect(text).toContain('section NOT_STARTED');
    expect(text).toMatch(/Decommission legacy client database :crit/);

    await page.getByRole('button', { name: 'Remove Legacy Client Database from scope' }).click();
    await expect(page.getByText(/Choose an initiative/)).toBeVisible();
  });
});
