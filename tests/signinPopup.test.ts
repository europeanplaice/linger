import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

async function expectLoginPopupUrl(page: import('@playwright/test').Page, selectAccount = false) {
  const url = new URL(await page.evaluate(() => (window as Window & { lastPopupUrl?: string }).lastPopupUrl ?? ''), baseUrl)
  expect(url.pathname).toBe('/auth/login')
  expect(url.searchParams.get('channel_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(url.searchParams.get('select_account')).toBe(selectAccount ? '1' : null)
}

test('App primary and alternate sign-in buttons open the intended OAuth URLs', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
  await page.addInitScript(() => {
    ;(window as Window & { lastPopupUrl?: string }).lastPopupUrl = ''
    window.open = ((url?: string | URL) => {
      ;(window as Window & { lastPopupUrl?: string }).lastPopupUrl = String(url ?? '')
      return { closed: true, close() {} } as WindowProxy
    }) as typeof window.open
  })
  await page.goto(baseUrl)
  const primary = page.getByRole('button', { name: 'Sign in with Google' })
  await expect(primary).toBeVisible()
  await primary.click()
  await expectLoginPopupUrl(page)

  await page.getByRole('button', { name: 'Use another account' }).click()
  await expectLoginPopupUrl(page, true)
})

test('a blocked Google popup preserves the unlocked passkey for retry', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
  await page.addInitScript(() => { window.open = () => null })
  await page.goto(baseUrl)
  const google = page.getByRole('button', { name: 'Sign in with Google', exact: true })
  await google.click()
  await expect(page.getByRole('alert')).toContainText('Google sign-in could not be completed')
  await expect(google).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toHaveCount(0)
})

test('history restoration requests unlock again after discarding memory keys', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
  await page.goto(baseUrl)
  await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toBeVisible()
})
