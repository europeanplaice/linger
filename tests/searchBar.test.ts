import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

// State/branch coverage lives in tests/unit/searchBar.test.tsx. These cases
// cover native input constraints and the App -> search -> editor connection.
test.describe('SearchBar browser behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseUrl}/tests/searchBarHarness.html`)
  })

  test('enforces 500 character limit on input', async ({ page }) => {
    const overLimit = 'a'.repeat(600)
    await page.getByPlaceholder('Search entries...').fill(overLimit)
    const value = await page.getByPlaceholder('Search entries...').inputValue()
    expect(value.length).toBeLessThanOrEqual(500)
  })
})

test('searching in the app and selecting a result opens that diary entry', async ({ page }) => {
  await installMockOAuthCredentials(page)
  await page.addInitScript(() => localStorage.setItem('linger_language', 'en'))
  const meta = { id: 'search-entry', name: 'diary-2026-04-01.txt', version: '1' }
  await page.route('/api/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('/api/s3/entry-status/**', route => route.fulfill({ json: { status: 'disabled' } }))
  await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true, email: 'person@example.com', googleSub: 'person' } }))
  await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [meta] } }))
  await page.route('/api/drive/milestones', route => route.fulfill({ json: [] }))
  await page.route('/api/drive/search', route => route.fulfill({ json: { files: [meta] } }))
  await page.route('/api/drive/entry/**', route => {
    const requestedDate = new URL(route.request().url()).pathname.split('/').pop()
    return requestedDate === '2026-04-01'
      ? route.fulfill({ json: { entry: { date: '2026-04-01', content: 'alpha diary from April' }, meta } })
      : route.fulfill({ status: 404, json: {} })
  })

  await page.goto(baseUrl)
  await page.getByRole('searchbox', { name: 'Search entries...' }).fill('alpha')
  await page.getByRole('button', { name: /April 1, 2026.*alpha/ }).click()
  await expect(page.locator('.editor-textarea')).toHaveCount(1)
  await expect(page.locator('.editor-textarea')).toHaveValue('alpha diary from April')
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await expect(page.locator('.search-results')).toHaveCount(0)
})
