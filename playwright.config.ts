import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  testIgnore: ['**/unit/**'],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    storageState: 'tests/storageState.en.json',
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
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
})
