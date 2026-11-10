import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

async function expectLoginPopupUrl(page: import('@playwright/test').Page, selectAccount = false) {
  const url = new URL(await page.evaluate(() => (window as Window & { lastPopupUrl?: string }).lastPopupUrl ?? ''), baseUrl)
  expect(url.pathname).toBe('/auth/login')
  expect(url.searchParams.get('channel_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(url.searchParams.get('select_account')).toBe(selectAccount ? '1' : null)
}

for (const selectAccount of [false, true]) {
  test(`App ${selectAccount ? 'alternate' : 'primary'} sign-in button opens the intended OAuth URL`, async ({ page }) => {
    await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
    await page.addInitScript(() => {
      ;(window as Window & { lastPopupUrl?: string }).lastPopupUrl = ''
      window.open = ((url?: string | URL) => {
        ;(window as Window & { lastPopupUrl?: string }).lastPopupUrl = String(url ?? '')
        return { closed: true, close() {} } as WindowProxy
      }) as typeof window.open
    })
    await page.goto(baseUrl)
    // Each button starts its own flow. A closed popup can still complete over
    // BroadcastChannel, so the mock leaves sign-in pending and disables both buttons.
    const button = page.getByRole('button', { name: selectAccount ? 'Use another account' : 'Sign in with Google', exact: true })
    await expect(button).toBeVisible()
    await button.click()
    await expectLoginPopupUrl(page, selectAccount)
    await expect(page.getByRole('button', { name: 'Connecting Google Drive…', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Use another account', exact: true })).toBeDisabled()
  })
}

test('a blocked Google popup preserves the unlocked passkey for retry', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
  await page.addInitScript(() => { window.open = () => null })
  await page.goto(baseUrl)
  const google = page.getByRole('button', { name: 'Sign in with Google', exact: true })
  await google.click()
  await expect(page.getByRole('alert')).toHaveText('Allow popups for Linger, then try connecting Google again.')
  await expect(google).toBeVisible()
  await expect(google).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toHaveCount(0)
})

test('history restoration requests unlock again after discarding memory keys', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0, seedVaultOnModuleLoad: 1 })
  await page.goto(baseUrl)
  await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toBeVisible()
})
