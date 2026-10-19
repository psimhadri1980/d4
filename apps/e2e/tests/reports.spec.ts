import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { RUN } from './helpers';

test.describe('scheduled reports', () => {
  test.describe.configure({ timeout: 90_000 });

  test('schedule a roadmap PDF, run it now, download, change, pause and delete', async ({ page }) => {
    const name = `${RUN} Weekly roadmap`;
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roadmap' }).click();
    await page.getByRole('checkbox', { name: 'Client Data Consolidation' }).check();
    await expect(page.getByLabel('Roadmap summary')).toContainText('8 items');

    await page.getByRole('button', { name: 'Schedule…' }).click();
    const form = page.getByRole('form', { name: 'Schedule report' });
    await form.getByLabel('Report name').fill(name);
    await expect(form.getByLabel('Repeat', { exact: true })).toHaveValue('weekly');
    await form.getByLabel('On', { exact: true }).selectOption({ label: 'Friday' });
    await form.getByLabel('At', { exact: true }).selectOption('7');
    await form.getByRole('button', { name: 'Schedule' }).click();
    await page.getByRole('link', { name: 'Manage in Reports' }).click();

    const row = page.getByRole('table', { name: 'Scheduled reports' }).locator('tr', { hasText: name });
    await expect(row).toContainText('PDF picture of a roadmap');
    await expect(row).toContainText('Every Friday at 07:00 UTC');
    await expect(row).toContainText('Not run yet');

    await row.getByRole('button', { name: 'Run now' }).click();
    await expect(row.locator('.badge.job-succeeded')).toBeVisible({ timeout: 45_000 });
    const [file] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Download' }).click()]);
    expect(file.suggestedFilename()).toBe('roadmap-client-data-consolidation.pdf');
    expect((await readFile((await file.path())!)).subarray(0, 5).toString()).toBe('%PDF-');

    await row.getByRole('button', { name: 'Change' }).click();
    await row.getByLabel('Repeat', { exact: true }).selectOption('daily');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('Every day at 07:00 UTC');

    await row.getByRole('button', { name: 'Pause' }).click();
    await expect(row.locator('.badge', { hasText: 'paused' })).toBeVisible();
    await row.getByRole('button', { name: 'Resume' }).click();
    await expect(row.locator('.badge', { hasText: 'paused' })).toHaveCount(0);

    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(row).toHaveCount(0);
  });
});
