import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  expect: { timeout: 10_000 },
  testIgnore: ['**/unit/**', '**/privacy/**'],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    storageState: 'tests/storageState.en.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium',      use: { ...devices['Desktop Chrome'] } },
    // WebKit is slow to run locally; exercise it in CI only.
    ...(process.env.CI
      ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }]
      : []),
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: ['**/mobileBack.test.ts'],
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      stdout: process.env.CI ? 'pipe' : 'ignore',
    },
    {
      // Vite proxies API and auth requests here during browser tests.
      command: 'npm run workers:dev',
      url: 'http://127.0.0.1:8788',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: process.env.CI ? 'pipe' : 'ignore',
    },
  ],
})
