import { expect, test } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

test.describe('design system', () => {
  test('uses the open stand-in brand font', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('dev-admin')).toBeVisible();
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(font).toMatch(/^"?Source Sans 3"?/);
    expect(await page.evaluate(() => document.fonts.check('14px "Source Sans 3"'))).toBe(true);
  });

  test('theme picker switches to dark, persists across reloads, and returns to system', async ({ page }) => {
    await page.goto('/');
    const picker = page.getByRole('combobox', { name: 'Theme' });
    await picker.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(22, 22, 22)');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');

    await page.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 244, 244)');
    await page.getByRole('combobox', { name: 'Theme' }).selectOption('system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('Explorer is highlighted on element pages and Queries on the queries page', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search elements').fill('Client Master');
    await page.getByRole('link', { name: /^Client Master/ }).first().click();
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Explorer' })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Queries' }).click();
    await expect(nav.getByRole('link', { name: 'Queries' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Explorer' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('a tall query tab scrolls its own panel; the tab strip stays put', async ({ page }) => {
    // Orphans of our own, so the result table exists on a fresh database too.
    const ws = await defaultWorkspaceId();
    const orphans: { id: string; version: number }[] = [];
    for (let i = 1; i <= 6; i++) {
      orphans.push(
        await api(`/v1/workspaces/${ws}/elements`, {
          method: 'POST',
          body: JSON.stringify({ type: 'DataStore', attrs: { name: `${RUN} orphan ${i}`, category: 'OPERATIONAL' } }),
        }),
      );
    }
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Queries' }).click();
    await page.locator('section.accordion').first().getByRole('button', { name: /Orphan elements/ }).click();
    const panel = page.getByRole('tabpanel');
    await panel.getByRole('button', { name: 'Run' }).click();
    await expect(panel.locator('.results table')).toBeVisible();

    const strip = page.getByRole('tablist', { name: 'Open queries' });
    const before = await strip.boundingBox();
    const scrolled = await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { overflows: el.scrollHeight > el.clientHeight, top: el.scrollTop };
    });
    expect(scrolled.overflows).toBe(true);
    expect(scrolled.top).toBeGreaterThan(0);
    const after = await strip.boundingBox();
    expect(after).toEqual(before);
    expect(await strip.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);

    for (const o of orphans) await api(`/v1/workspaces/${ws}/elements/${o.id}?expectedVersion=${o.version}`, { method: 'DELETE' });
  });
});
