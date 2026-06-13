import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.describe('sidebar empty state', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('linger_language', 'en')
    })
  })

  test('shows hint when there are no diary entries', async ({ page }) => {
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true } }))
    await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))

    await page.goto(baseUrl)
    await expect(page.locator('.sidebar-empty-hint')).toBeVisible()
    await expect(page.locator('.sidebar-empty-hint')).toContainText('No entries yet')
  })

  test('does not show hint when there are entries', async ({ page }) => {
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true } }))
    await page.route('/api/drive/entries', route =>
      route.fulfill({
        json: {
          files: [{ id: 'file-1', name: 'diary-2026-05-01.json', version: '1' }],
        },
      }),
    )

    await page.goto(baseUrl)
    await expect(page.locator('.sidebar-empty-hint')).toHaveCount(0)
  })

  test('hint disappears after the first entry is saved', async ({ page }) => {
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true } }))

    let entryExists = false
    await page.route('/api/drive/entries', route =>
      route.fulfill({
        json: {
          files: entryExists
            ? [{ id: 'file-1', name: 'diary-2026-05-15.json', version: '1' }]
            : [],
        },
      }),
    )
    await page.route('/api/drive/entry/**', async route => {
      if (route.request().method() === 'PUT' || route.request().method() === 'POST') {
        entryExists = true
        await route.fulfill({
          json: { id: 'file-1', name: 'diary-2026-05-15.json', version: '1' },
        })
      } else {
        await route.fulfill({ status: 404, body: '' })
      }
    })
    await page.route('/api/drive/anniversaries', route =>
      route.fulfill({ json: [] }),
    )

    await page.goto(baseUrl)
    await expect(page.locator('.sidebar-empty-hint')).toBeVisible()

    await page.locator('.editor-textarea').fill('Hello diary')
    await page.locator('.btn-save').click()
    await expect(page.locator('.sidebar-empty-hint')).toHaveCount(0)
  })
})

test.describe('sidebar error state', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('linger_language', 'en')
    })
    await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true } }))
    await page.route('/api/drive/entries', route => route.abort())
  })

  test('shows error message when entries fail to load', async ({ page }) => {
    await page.goto(baseUrl)
    const errorEl = page.locator('.sidebar-status.error')
    await expect(errorEl).toBeVisible()
    await expect(errorEl).toContainText('Failed to load entries')
  })

  test('does not show empty hint when there is a load error', async ({ page }) => {
    await page.goto(baseUrl)
    await expect(page.locator('.sidebar-status.error')).toBeVisible()
    await expect(page.locator('.sidebar-empty-hint')).toHaveCount(0)
  })
})