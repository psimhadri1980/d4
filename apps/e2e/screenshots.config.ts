import { defineConfig, devices } from '@playwright/test';

/** Captures the screenshots used by user-manual/. Run: deploy/dev.sh e2e -c screenshots.config.ts */
export default defineConfig({
  testDir: './screenshots',
  testMatch: /.*\.shots\.ts/,
  outputDir: './results/artifacts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
