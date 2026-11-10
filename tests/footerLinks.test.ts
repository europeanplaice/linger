import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'
import { baseUrl } from './baseUrl'

// Vite dev server only serves public/*.html at /*.html (not clean URLs),
// so we mock the clean URL paths to serve the correct static HTML.
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const homeHtml = readFileSync(resolve(PUBLIC_DIR, 'home.html'), 'utf-8')

test.describe('footer links — root (LoginScreen)', () => {
  test.beforeEach(async ({ page, context }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('linger_language', 'en')
    })
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: false } }))
    await context.route('/home', route =>
      route.fulfill({ body: homeHtml, contentType: 'text/html; charset=utf-8' }),
    )
  })

  test('About link opens /home in a new tab', async ({ page, context }) => {
    await page.goto(baseUrl)
    await page.waitForSelector('.login-footer')

    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.login-footer a[href="/home"]').click(),
    ])
    await newPage.waitForLoadState()

    await expect(newPage).toHaveURL(/\/home$/)
    await expect(newPage.locator('h1')).toHaveText('Linger')
  })
})
