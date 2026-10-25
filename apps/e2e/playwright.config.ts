import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against the gateway (E2E_BASE_URL, default http://localhost:5173), whatever mix of
 * container and local apps is behind it; the e2e container uses the host network, so the browser
 * sees the same URLs (and OIDC redirect/issuer) as a developer's browser.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './results/artifacts',
  // Tests share one workspace; run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: './results/report', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: '.auth/admin.json' },
      dependencies: ['setup'],
    },
  ],
});
