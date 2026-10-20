import { expect, test } from '@playwright/test';
import { openNav } from './helpers';

test.describe('navigation', () => {
  test('the icon rail expands to labelled menus with sub-items, and remembers it', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav).toHaveClass(/collapsed/);
    await nav.getByRole('button', { name: 'Expand navigation' }).click();
    await expect(nav).not.toHaveClass(/collapsed/);
    await expect(nav.getByRole('heading', { name: 'Data management' })).toBeVisible();
    await expect(nav.getByRole('heading', { name: 'Reporting' })).toBeVisible();

    await nav.getByRole('button', { name: 'Show Matrices pages' }).click();
    await nav.getByRole('link', { name: 'Lifecycle heat-map' }).click();
    await expect(page).toHaveURL(/matrices\?kind=lifecycle/);
    await expect(nav.getByRole('link', { name: 'Lifecycle heat-map' })).toHaveAttribute('aria-current', 'page');
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText('Matrices');
    await expect(crumbs).toContainText('Lifecycle heat-map');

    await page.reload();
    await expect(nav).not.toHaveClass(/collapsed/);
    await nav.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(nav).toHaveClass(/collapsed/);
  });

  test('admin pages each have their own address', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Admin', 'Usage');
    await expect(page).toHaveURL(/\/admin\/usage$/);
    await expect(page.getByRole('heading', { name: 'Usage', level: 2 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Webhooks' })).toHaveCount(0);
  });

  test('Ctrl K searches pages and elements', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Explorer');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    const box = dialog.getByRole('combobox', { name: 'Search pages, elements and queries' });
    await expect(box).toBeFocused();
    await box.fill('decis');
    await expect(dialog.getByRole('option', { name: /Decisions/ }).first()).toBeVisible();
    await box.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/decisions/);

    await page.getByRole('button', { name: 'Search pages, elements and queries' }).click();
    await box.fill('Core Banking');
    const element = dialog.getByRole('option', { name: /Core Banking/ }).first();
    await expect(element).toBeVisible();
    await element.click();
    await expect(page).toHaveURL(/\/e\/[0-9A-Z]{26}$/);
  });
});
