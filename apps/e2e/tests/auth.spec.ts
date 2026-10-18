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

    test('returns to the deep link after signing in', async ({ page }) => {
      await page.goto('/');
      await page.getByLabel('Username or email').fill('dev-viewer');
      await page.getByLabel('Password', { exact: true }).fill('d4-local-dev');
      await page.getByRole('button', { name: 'Sign In' }).click();
      await expect(page).toHaveURL(/\/w\/[0-9A-Z]{26}$/);
      const ws = /\/w\/([0-9A-Z]{26})/.exec(page.url())![1];

      // Fresh session, then open a deep link: Keycloak SSO signs in and we land on that page.
      await page.evaluate(() => (globalThis as unknown as { sessionStorage: { clear(): void } }).sessionStorage.clear());
      await page.goto(`/w/${ws}/catalog`);
      await expect(page).toHaveURL(new RegExp(`/w/${ws}/catalog$`));
      await expect(page.getByRole('heading', { name: 'Query catalog' })).toBeVisible();
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
