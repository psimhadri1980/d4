import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as setup } from '@playwright/test';
import { parse } from 'yaml';
import { api, defaultWorkspaceId, signIn } from './helpers';

setup('import the sample model', async () => {
  // Idempotent: re-importing the sample changes nothing when it is already there.
  const doc = parse(readFileSync(join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml'), 'utf8'));
  const ws = await defaultWorkspaceId();
  const res = await api<{ ok: boolean; issues: unknown[] }>(`/v1/workspaces/${ws}/import`, {
    method: 'POST',
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`sample import failed: ${JSON.stringify(res.issues)}`);
});

setup('sign in as admin', async ({ page }) => {
  await signIn(page, 'admin');
  // Keycloak's SSO cookie lets later tests sign in silently via a redirect.
  await page.context().storageState({ path: '.auth/admin.json' });
});
