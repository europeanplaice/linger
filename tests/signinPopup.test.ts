import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

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
  await expect.poll(() => page.evaluate(() => (window as Window & { lastPopupUrl?: string }).lastPopupUrl)).toBe('/auth/login')

  await page.getByRole('button', { name: 'Use another account' }).click()
  await expect.poll(() => page.evaluate(() => (window as Window & { lastPopupUrl?: string }).lastPopupUrl)).toBe('/auth/login?select_account=1')
})
