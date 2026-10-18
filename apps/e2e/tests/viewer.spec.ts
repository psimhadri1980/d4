import { expect, test } from '@playwright/test';
import { RUN, signIn } from './helpers';

test.describe('read-only viewer', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('can explore but is refused when saving', async ({ page }) => {
    await signIn(page, 'viewer');
    await page.getByLabel('Search elements').fill('Client Master');
    await expect(page.locator('.items li').first()).toContainText('Client Master');

    await page.getByRole('link', { name: '+ New element' }).click();
    await page.getByLabel('Type').selectOption('Platform');
    await page.getByLabel('Name *').fill(`${RUN} Viewer attempt`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('alert')).toContainText('You do not have permission to do this.');
  });
});
