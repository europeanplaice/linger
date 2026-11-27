import { defineConfig, devices } from '@playwright/test'

// Browser-sensitive suites (auth/passkey flows, IndexedDB, BroadcastChannel,
// CSS layout, navigation, and code splitting). Pure component/hook harness
// suites are covered on Chromium to keep CI wall-clock time fast.
const WEBKIT_TEST_MATCH = [
  '**/authRestore.test.ts',
  '**/authUx.test.ts',
  '**/codeSplitting.test.ts',
  '**/designRegression.test.ts',
  '**/footerLinks.test.ts',
  '**/hadSession.test.ts',
  '**/milestoneNavigation.test.ts',
  '**/multitab.test.ts',
  '**/passkeyFlow.test.ts',
  '**/reauthPendingSave.test.ts',
  '**/secureLocalBrowser.test.ts',
  '**/sidebarEmptyState.test.ts',
  '**/signinPopup.test.ts',
]

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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // WebKit is slow to run locally; exercise browser-sensitive suites in CI only.
    ...(process.env.CI
      ? [
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
            testMatch: WEBKIT_TEST_MATCH,
          },
        ]
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
      // Lightweight stand-in for `npm run workers:dev` during mocked browser tests.
      // Responds immediately without booting wrangler/miniflare so unmocked
      // background requests (e.g. /api/holidays, /api/s3/entry-status) receive
      // clean 401/200 responses instead of Vite proxy ECONNREFUSED 500s.
      command: 'node tests/helpers/stubApiServer.mjs',
      port: 8788,
      reuseExistingServer: !process.env.CI,
      stdout: process.env.CI ? 'pipe' : 'ignore',
    },
  ],
})
