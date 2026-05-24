import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.describe('i18n', () => {
  test('defaults to Japanese when browser language is not ja/en', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR' })
    const page = await context.newPage()

    await page.addInitScript(() => {
      localStorage.removeItem('linger_language')
    })

    await page.goto(`${baseUrl}/tests/loginScreenHarness.html`)
    await page.evaluate(() => {
      window.loginScreenHarness.render()
    })

    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await expect(page).toHaveTitle('Linger')

    await context.close()
  })

  test('falls back to browser language when no stored preference (en)', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()

  await page.addInitScript(() => {
    localStorage.removeItem('linger_language')
  })

  await page.goto(`${baseUrl}/tests/loginScreenHarness.html`)
  await page.evaluate(() => {
    window.loginScreenHarness.render()
  })

  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page).toHaveTitle('Linger')

  await context.close()
})

test('falls back to browser language when no stored preference (ja)', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ja-JP' })
  const page = await context.newPage()

  await page.addInitScript(() => {
    localStorage.removeItem('linger_language')
  })

  await page.goto(`${baseUrl}/tests/loginScreenHarness.html`)
  await page.evaluate(() => {
    window.loginScreenHarness.render()
  })

  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
  await expect(page).toHaveTitle('Linger')

  await context.close()
})

test('switches between Japanese and English from settings and persists the choice', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('linger_language', 'ja')
    })

    await page.goto(`${baseUrl}/tests/settingsModalHarness.html`)
    await page.evaluate(() => {
      window.settingsHarness.render({ modalOpen: true })
    })

    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible()

    await page.getByLabel('言語').click()
    await page.getByRole('option', { name: 'English' }).click()

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('linger_language'))).toBe('en')
  })
})
