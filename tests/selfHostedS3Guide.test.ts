import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const dist = resolve('dist')
const origin = 'https://linger-guide.test'
const guideUrl = `${origin}/self-hosted-s3`
const englishHeading = 'Bring your own S3 bucket'
const japaneseHeading = '自分のAWS S3バケットへのバックアップ設定'

// Group the tests so they can share one build of dist, even when CI shards the suite.
test.describe.configure({ mode: 'default' })
test.skip(({ browserName }) => browserName !== 'chromium', 'Only Chromium builds the shared dist directory')

let contentSecurityPolicy: string

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (!(process.env.USE_EXISTING_DIST === '1' && existsSync(resolve(dist, '_headers')))) {
    execSync('npx vite build', { stdio: 'pipe' })
  }
  const headers = readFileSync(resolve(dist, '_headers'), 'utf-8')
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1]
  if (!policy) throw new Error('Built _headers is missing Content-Security-Policy')
  contentSecurityPolicy = policy
})

test.beforeEach(async ({ page }) => {
  // Serve the build with the CSP from the Pages deployment artifact.
  await page.route((url) => url.origin === origin && url.pathname === '/self-hosted-s3', (route) =>
    route.fulfill({
      path: resolve(dist, 'self-hosted-s3.html'),
      headers: { 'Content-Security-Policy': contentSecurityPolicy },
    }),
  )
  await page.route(`${guideUrl}.js`, (route) =>
    route.fulfill({ path: resolve(dist, 'self-hosted-s3.js') }),
  )
  await page.route(`${origin}/favicon.svg`, (route) =>
    route.fulfill({ path: resolve(dist, 'favicon.svg') }),
  )
})

test('opens the Japanese guide and switches languages under the deployment CSP', async ({ page }) => {
  await page.goto(`${guideUrl}?lang=ja`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(japaneseHeading)

  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(englishHeading)

  await page.getByRole('button', { name: '日本語' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(japaneseHeading)
})

test('shows the English guide when the language script fails to load', async ({ page }) => {
  await page.route(`${guideUrl}.js`, (route) => route.abort())
  await page.goto(`${guideUrl}?lang=ja`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(englishHeading)
})
