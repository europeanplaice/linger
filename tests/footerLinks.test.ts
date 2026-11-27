import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.describe('footer links — root (PasskeyGate)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('linger_language', 'en')
    })
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: false } }))
  })

  test('About link navigates to the #about section on the page', async ({ page }) => {
    await page.goto(baseUrl)
    await page.waitForSelector('.login-footer')

    await page.locator('.login-footer a[href="#about"]').click()

    await expect(page).toHaveURL(/#about$/)
    await expect(page.locator('#about h2')).toHaveText('What is Linger?')
    await expect(page.locator('#about h2')).toBeInViewport()
  })
})
