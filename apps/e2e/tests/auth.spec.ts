import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('sign-in', () => {
  test('signed-in admin lands in the explorer with roles shown', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/w\/[0-9A-Z]{26}$/);
    await expect(page.getByText('dev-admin')).toBeVisible();
    await expect(page.getByText(/admin, query-author, query-steward/)).toBeVisible();
    await expect(page.getByRole('combobox').first()).toHaveValue(/[0-9A-Z]{26}/);
  });

  test.describe('without a session', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('redirects to Keycloak and returns to the requested page', async ({ page }) => {
      await page.goto('/w/does-not-matter');
      await expect(page).toHaveURL(/localhost:8080\/realms\/d4\//);
      await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
    });

    test('viewer can sign in and sign out', async ({ page }) => {
      await signIn(page, 'viewer');
      await expect(page.getByText('viewer', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/localhost:(8080|5173)/);
      await page.goto('/');
      await expect(page).toHaveURL(/localhost:8080\/realms\/d4\//);
    });
  });
});
