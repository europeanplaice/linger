import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'
import { baseUrl } from './baseUrl'

// Vite dev server only serves public/*.html at /*.html (not clean URLs),
// so we mock the clean URL paths to serve the correct static HTML.
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const homeHtml = readFileSync(resolve(PUBLIC_DIR, 'home.html'), 'utf-8')
const privacyHtml = readFileSync(resolve(PUBLIC_DIR, 'privacy.html'), 'utf-8')
const termsHtml = readFileSync(resolve(PUBLIC_DIR, 'terms-of-service.html'), 'utf-8')

test.describe('footer links — root (LoginScreen)', () => {
  test.beforeEach(async ({ page, context }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('linger_language', 'en')
    })
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: false } }))
    await context.route('/home', route =>
      route.fulfill({ body: homeHtml, contentType: 'text/html; charset=utf-8' }),
    )
    await context.route('/privacy', route =>
      route.fulfill({ body: privacyHtml, contentType: 'text/html; charset=utf-8' }),
    )
    await context.route('/terms-of-service', route =>
      route.fulfill({ body: termsHtml, contentType: 'text/html; charset=utf-8' }),
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

  test('Privacy Policy link opens /privacy in a new tab', async ({ page, context }) => {
    await page.goto(baseUrl)
    await page.waitForSelector('.login-footer')

    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.login-footer a[href="/privacy"]').click(),
    ])
    await newPage.waitForLoadState()

    await expect(newPage).toHaveURL(/\/privacy$/)
    await expect(newPage.locator('h1')).toHaveText('Privacy Policy')
  })

  test('Terms of Service link opens /terms-of-service in a new tab', async ({ page, context }) => {
    await page.goto(baseUrl)
    await page.waitForSelector('.login-footer')

    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.login-footer a[href="/terms-of-service"]').click(),
    ])
    await newPage.waitForLoadState()

    await expect(newPage).toHaveURL(/\/terms-of-service$/)
    await expect(newPage.locator('h1')).toHaveText('Terms of Service')
  })
})

test.describe('footer links — /home', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('/privacy', route =>
      route.fulfill({ body: privacyHtml, contentType: 'text/html; charset=utf-8' }),
    )
    await page.route('/terms-of-service', route =>
      route.fulfill({ body: termsHtml, contentType: 'text/html; charset=utf-8' }),
    )
  })

  test('Privacy Policy link navigates to /privacy', async ({ page }) => {
    await page.goto(`${baseUrl}/home.html`)

    await page.locator('.footer a[href="/privacy"]').click()
    await page.waitForLoadState()

    await expect(page).toHaveURL(/\/privacy$/)
    await expect(page.locator('h1')).toHaveText('Privacy Policy')
  })

  test('Terms of Service link navigates to /terms-of-service', async ({ page }) => {
    await page.goto(`${baseUrl}/home.html`)

    await page.locator('.footer a[href="/terms-of-service"]').click()
    await page.waitForLoadState()

    await expect(page).toHaveURL(/\/terms-of-service$/)
    await expect(page.locator('h1')).toHaveText('Terms of Service')
  })
})
