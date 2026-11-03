import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

async function expectLoginPopupUrl(page: import('@playwright/test').Page, selectAccount = false) {
  const url = new URL(await page.evaluate(() => (window as Window & { lastPopupUrl?: string }).lastPopupUrl ?? ''), baseUrl)
  expect(url.pathname).toBe('/auth/login')
  expect(url.searchParams.get('channel_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(url.searchParams.get('select_account')).toBe(selectAccount ? '1' : null)
}

test('App primary and alternate sign-in buttons open the intended OAuth URLs', async ({ page }) => {
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
