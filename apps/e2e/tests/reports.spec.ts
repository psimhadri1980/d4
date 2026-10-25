import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { RUN } from './helpers';

/** The local mail catcher's Mailpit-compatible API (mocks/smtp) as seen from the test container. */
const INBOX = process.env.E2E_INBOX_URL ?? 'http://smtp:8025';

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
    const inbox = `${RUN}@example.test`;
    await form.getByLabel('Email to (optional)').fill(inbox);
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

    // The run was emailed with the PDF attached.
    await expect(row).toContainText('Emailed to 1');
    const search = await (await fetch(`${INBOX}/api/v1/search?query=${encodeURIComponent(`to:${inbox}`)}`)).json() as { messages: { ID: string; Subject: string }[] };
    expect(search.messages).toHaveLength(1);
    expect(search.messages[0]!.Subject).toContain(name);
    const msg = await (await fetch(`${INBOX}/api/v1/message/${search.messages[0]!.ID}`)).json() as { Attachments: { FileName: string }[]; Text: string };
    expect(msg.Attachments.map((a) => a.FileName)).toEqual(['roadmap-client-data-consolidation.pdf']);
    expect(msg.Text).toContain('/reports');

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
