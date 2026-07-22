import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/loginScreenHarness.html`)
}

async function render(
  page: import('@playwright/test').Page,
  opts: { tokenExpired?: boolean; authError?: 'no_refresh_token' | null } = {},
) {
  await page.evaluate((opts) => {
    window.loginScreenHarness.render(opts)
  }, opts)
  await page.waitForSelector('.login-screen')
}

test.describe('LoginScreen — language toggle', () => {
  test('shows EN and 日本語 buttons', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const enBtn = page.locator('.login-lang-toggle button', { hasText: 'EN' })
    const jaBtn = page.locator('.login-lang-toggle button', { hasText: '日本語' })

    await expect(enBtn).toBeVisible()
    await expect(jaBtn).toBeVisible()
  })

  test('clicking EN switches UI to English', async ({ page }) => {
    await page.goto(`${baseUrl}/tests/loginScreenHarness.html`)
    await page.evaluate(() => localStorage.setItem('linger_language', 'ja'))
    await render(page)

    await page.locator('.login-lang-toggle button', { hasText: 'EN' }).click()

    await expect(page.locator('.btn-signin-google')).toContainText('Sign in with Google')
    const enBtn = page.locator('.login-lang-toggle button', { hasText: 'EN' })
    await expect(enBtn).toHaveAttribute('aria-pressed', 'true')
  })

  test('clicking 日本語 switches UI to Japanese', async ({ page }) => {
    await page.goto(`${baseUrl}/tests/loginScreenHarness.html`)
    await page.evaluate(() => localStorage.setItem('linger_language', 'en'))
    await render(page)

    await page.locator('.login-lang-toggle button', { hasText: '日本語' }).click()

    await expect(page.locator('.btn-signin-google')).toContainText('Google でログイン')
    const jaBtn = page.locator('.login-lang-toggle button', { hasText: '日本語' })
    await expect(jaBtn).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('LoginScreen — auth error panel', () => {
  test('is hidden when there is no auth error', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await expect(page.locator('.auth-error-panel')).toHaveCount(0)
  })

  test('shows recovery panel when Google omits a refresh token', async ({ page }) => {
    await loadHarness(page)
    await render(page, { authError: 'no_refresh_token' })

    const panel = page.locator('.auth-error-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('role', 'alert')
    await expect(panel.locator('h2')).toContainText("Google didn't renew access")

    const permissionsLink = panel.locator('.btn-open-permissions')
    await expect(permissionsLink).toHaveAttribute('href', 'https://myaccount.google.com/permissions')
    await expect(permissionsLink).toHaveAttribute('target', '_blank')
    await expect(permissionsLink).toHaveAttribute('rel', 'noopener noreferrer')
  })

  test('dismiss button calls onDismissAuthError', async ({ page }) => {
    await loadHarness(page)
    await render(page, { authError: 'no_refresh_token' })

    await page.locator('.btn-dismiss-auth-error').click()

    const dismissed = await page.evaluate(() => window.loginScreenHarness.dismissedAuthError)
    expect(dismissed).toBe(true)
  })
})

test.describe('LoginScreen — footer links', () => {
  test('shows About, Privacy Policy and Terms of Service links', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const aboutLink = page.locator('.login-footer a[href="/home"]')
    const privacyLink = page.locator('.login-footer a[href="/privacy"]')
    const tosLink = page.locator('.login-footer a[href="/terms-of-service"]')

    await expect(aboutLink).toBeVisible()
    await expect(aboutLink).toHaveText('About')

    await expect(privacyLink).toBeVisible()
    await expect(privacyLink).toHaveText('Privacy Policy')

    await expect(tosLink).toBeVisible()
    await expect(tosLink).toHaveText('Terms of Service')
  })

  test('links open in new tab with noopener noreferrer', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const aboutLink = page.locator('.login-footer a[href="/home"]')
    const privacyLink = page.locator('.login-footer a[href="/privacy"]')
    const tosLink = page.locator('.login-footer a[href="/terms-of-service"]')

    await expect(aboutLink).toHaveAttribute('target', '_blank')
    await expect(aboutLink).toHaveAttribute('rel', 'noopener noreferrer')

    await expect(privacyLink).toHaveAttribute('target', '_blank')
    await expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer')

    await expect(tosLink).toHaveAttribute('target', '_blank')
    await expect(tosLink).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
