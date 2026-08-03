import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.describe('code splitting', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('linger_language', 'en')
    })
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true } }))
    await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))
    await page.route('/api/drive/milestones', route => route.fulfill({ json: [] }))
  })

  test('SettingsModal is only fetched after the user opens settings', async ({ page }) => {
    const requested: string[] = []
    page.on('request', req => {
      if (req.url().includes('SettingsModal')) requested.push(req.url())
    })

    await page.goto(baseUrl)
    await expect(page.locator('.sidebar-empty-hint')).toBeVisible()

    expect(requested, 'SettingsModal should not load with the initial page').toEqual([])

    await page.locator('.btn-settings').click()
    await expect(page.locator('.settings-dialog')).toBeVisible()

    expect(requested, 'SettingsModal should load once settings is opened').toHaveLength(1)
  })
})
