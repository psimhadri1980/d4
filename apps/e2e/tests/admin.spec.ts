import { expect, test } from '@playwright/test';
import { RUN, signIn } from './helpers';

test.describe('administration', () => {
  test('admins create, rename, staff, archive and restore a workspace', async ({ page }) => {
    const name = `${RUN} Lab`;
    await page.goto('/');
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

    const create = page.getByRole('form', { name: 'New workspace' });
    await create.getByLabel('New workspace name').fill(name);
    await expect(create.getByLabel('Slug')).toHaveValue(`${RUN.toLowerCase()}-lab`);
    await create.getByRole('button', { name: 'Create workspace' }).click();
    // The slug stays put while the name is being edited.
    const row = page.getByRole('table', { name: 'All workspaces' }).locator('tr', { hasText: `${RUN.toLowerCase()}-lab` });
    await expect(row.locator('.badge')).toHaveText('active');

    await row.getByRole('button', { name: 'Rename' }).click();
    await row.getByLabel(`New name for ${name}`).fill(`${name} 2`);
    await row.getByRole('button', { name: 'Save' }).click();
    const renamed = row;
    await expect(renamed).toContainText(`${name} 2`);

    // Grant the viewer a role in the new workspace, then take it away.
    const members = page.getByRole('region', { name: 'Members and roles' });
    await members.getByLabel('Roles for').selectOption({ label: `Workspace: ${name} 2` });
    await expect(members.getByText('No roles granted here yet.')).toBeVisible();
    const grant = members.getByRole('form', { name: 'Grant a role' });
    await grant.getByLabel('Person').selectOption({ label: 'dev-viewer@d4.localhost' });
    await grant.getByLabel('Role').selectOption('planner');
    await grant.getByRole('button', { name: 'Grant' }).click();
    const binding = members.getByRole('table', { name: 'Role bindings' }).locator('tr', { hasText: 'dev-viewer@d4.localhost' });
    await expect(binding).toContainText('planner');
    await binding.getByRole('button', { name: 'Remove planner from dev-viewer@d4.localhost' }).click();
    await expect(members.getByText('No roles granted here yet.')).toBeVisible();

    page.once('dialog', (d) => void d.accept());
    await renamed.getByRole('button', { name: 'Archive' }).click();
    await expect(renamed.locator('.badge')).toHaveText('archived');
    await expect(page.locator('.ws-picker select option', { hasText: `${name} 2` })).toHaveCount(0);
    await renamed.getByRole('button', { name: 'Restore' }).click();
    await expect(renamed.locator('.badge')).toHaveText('active');
    // Leave the test workspace archived.
    page.once('dialog', (d) => void d.accept());
    await renamed.getByRole('button', { name: 'Archive' }).click();
    await expect(renamed.locator('.badge')).toHaveText('archived');
  });

  test('admins create a workspace on an industry metamodel pack', async ({ page }) => {
    const name = `${RUN} Bank`;
    await page.goto('/');
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    const create = page.getByRole('form', { name: 'New workspace' });
    await create.getByLabel('New workspace name').fill(name);
    await create.getByLabel('Metamodel').selectOption('d4-banking');
    await expect(create).toContainText('BIAN');
    await create.getByRole('button', { name: 'Create workspace' }).click();
    const row = page.getByRole('table', { name: 'All workspaces' }).locator('tr', { hasText: `${RUN.toLowerCase()}-bank` });
    await expect(row).toContainText('d4-banking@0.1.0');
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Archive' }).click();
    await expect(row.locator('.badge')).toHaveText('archived');
  });

  test('admins see usage against the plan limits', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    const usage = page.getByRole('table', { name: 'Usage' });
    const elements = usage.getByRole('row', { name: /^Elements/ });
    await expect(elements).toContainText('100,000');
    await expect(elements.getByRole('meter', { name: 'Elements used' })).toBeVisible();
    await expect(usage.getByRole('row', { name: /^Stored files/ })).toContainText('5 GB');
  });

  test('admins back up the workspace and check it against the event log', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    const backups = page.getByRole('region', { name: 'Backups' });
    await backups.getByRole('button', { name: 'Back up now' }).click();
    await expect(backups.getByRole('status')).toContainText('Back up the graph: Saved:', { timeout: 30_000 });
    await expect(backups.getByRole('table', { name: 'Backup list' }).getByRole('row').nth(1)).toContainText('manual');

    await backups.getByRole('button', { name: 'Check against the event log' }).click();
    await expect(backups.getByRole('status')).toContainText('Matches the event log', { timeout: 30_000 });
  });

  test.describe('as a viewer', () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test('there is no Admin link and the page says why', async ({ page }) => {
      await signIn(page, 'viewer');
      await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
      const ws = /\/w\/([0-9A-Z]{26})/.exec(page.url())![1];
      await page.goto(`/w/${ws}/admin`);
      await expect(page.getByText('Administration needs the admin role.')).toBeVisible();
    });
  });
});
