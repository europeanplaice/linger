import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.beforeEach(async ({ page }) => {
  await page.goto(`${baseUrl}/tests/searchBarHarness.html`)
})

test.describe('SearchBar', () => {
  test('shows No results when search returns empty and indexing is complete', async ({ page }) => {
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.getByText('No results')).toBeVisible()
  })

  test('shows results when onSearch returns matches', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('alpha', {
        results: [{ date: '2026-04-01', snippet: 'alpha match' }],
        unindexedCount: 0,
        totalCount: 1,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.getByText('April 1, 2026')).toBeVisible()
    await expect(page.getByText('alpha match')).toBeVisible()
  })

  test('selecting a result calls onSelect and clears the search UI', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('alpha', {
        results: [{ date: '2026-04-01', snippet: 'alpha match' }],
        unindexedCount: 0,
        totalCount: 1,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await page.getByText('alpha match').click()

    expect(await page.evaluate(() => window.searchHarness.selectedDates())).toEqual(['2026-04-01'])
    await expect(page.getByPlaceholder('Search entries...')).toHaveValue('')
    await expect(page.locator('.search-results')).toHaveCount(0)
  })

  test('does not search while entriesLoading is true', async ({ page }) => {
    await page.clock.install()
    await page.evaluate(() => window.searchHarness.render({ entriesLoading: true }))
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.getByText('Loading entries…')).toBeVisible()
    await page.clock.fastForward(400)
    expect(await page.evaluate(() => window.searchHarness.calls())).toEqual([])

    await page.evaluate(() => window.searchHarness.render({ entriesLoading: false }))
    await page.clock.fastForward(300)
    await expect.poll(() => page.evaluate(() => window.searchHarness.calls())).toEqual(['alpha'])
  })

  test('shows partial results warning when unindexedCount > 0', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('alpha', {
        results: [{ date: '2026-04-01', snippet: 'alpha match' }],
        unindexedCount: 3,
        totalCount: 4,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.getByText('3 entries could not be loaded.')).toBeVisible()
  })

  test('does not show partial results warning when unindexedCount is 0', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('beta', {
        results: [],
        unindexedCount: 0,
        totalCount: 0,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('beta')
    await expect(page.getByText('No results')).toBeVisible()
    await expect(page.getByText(/could not be loaded/)).toHaveCount(0)
  })

  test('shows result count when results are returned', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('alpha', {
        results: [
          { date: '2026-04-01', snippet: 'alpha one' },
          { date: '2026-03-15', snippet: 'alpha two' },
        ],
        unindexedCount: 0,
        totalCount: 2,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.locator('.search-result-count')).toBeVisible()
    await expect(page.locator('.search-result-count')).toHaveText('2 results')
  })

  test('shows capped hint when totalCount exceeds displayed results', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('alpha', {
        results: [{ date: '2026-04-01', snippet: 'alpha match' }],
        unindexedCount: 0,
        totalCount: 50,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.locator('.search-result-capped')).toBeVisible()
    await expect(page.locator('.search-result-capped')).toContainText('50')
  })

  test('does not show capped hint when all results are displayed', async ({ page }) => {
    await page.evaluate(() => {
      window.searchHarness.setSearchResult('alpha', {
        results: [{ date: '2026-04-01', snippet: 'alpha match' }],
        unindexedCount: 0,
        totalCount: 1,
      })
    })
    await page.getByPlaceholder('Search entries...').fill('alpha')
    await expect(page.locator('.search-result-count')).toBeVisible()
    await expect(page.locator('.search-result-capped')).toHaveCount(0)
  })

  test('shows character count warning when query exceeds 400 chars', async ({ page }) => {
    const longQuery = 'a'.repeat(401)
    await page.getByPlaceholder('Search entries...').fill(longQuery)
    await expect(page.locator('.search-char-count')).toBeVisible()
    await expect(page.locator('.search-char-count')).toContainText('401/500')
  })

  test('enforces 500 character limit on input', async ({ page }) => {
    const overLimit = 'a'.repeat(600)
    await page.getByPlaceholder('Search entries...').fill(overLimit)
    const value = await page.getByPlaceholder('Search entries...').inputValue()
    expect(value.length).toBeLessThanOrEqual(500)
  })

  test('shows limit style when query reaches 500 chars', async ({ page }) => {
    const atLimit = 'a'.repeat(500)
    await page.getByPlaceholder('Search entries...').fill(atLimit)
    await expect(page.locator('.search-char-count--limit')).toBeVisible()
  })

})
