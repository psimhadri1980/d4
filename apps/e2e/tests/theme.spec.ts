import { expect, test } from '@playwright/test';

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
});
