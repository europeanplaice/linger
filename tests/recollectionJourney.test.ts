import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Compute same month/day in past years from the real "today" so the test is
// robust regardless of when it runs.
const now = new Date()
const oneYearAgo = ymd(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()))
const threeYearsAgo = ymd(new Date(now.getFullYear() - 3, now.getMonth(), now.getDate()))
const unrelated = ymd(new Date(now.getFullYear() - 2, now.getMonth(), now.getDate() === 1 ? 2 : 1))
const oneWeekAgo = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7))
const oneMonthAgo = ymd(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()))

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/recollectionJourneyHarness.html`)
}

async function render(
  page: import('@playwright/test').Page,
  opts: { dates: string[]; contents?: Record<string, string> },
) {
  await page.evaluate(o => window.recollectionHarness.render(o), opts)
  await page.waitForSelector('.recollection-view')
}

test.describe('RecollectionJourney', () => {
  test('shows "on this day" entries from past years, most recent first', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [oneYearAgo, threeYearsAgo, unrelated],
      contents: {
        [oneYearAgo]: 'A year ago I felt hopeful.',
        [threeYearsAgo]: 'Three years back, a different city.',
        [unrelated]: 'Unrelated day.',
      },
    })

    const onThisDay = page.locator('.recollection-section', { hasText: 'On this day' })
    const cards = onThisDay.locator('.recollection-card')
    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toContainText('A year ago I felt hopeful.')
    await expect(cards.nth(1)).toContainText('Three years back')
  })

  test('selecting a card reports the date', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [oneYearAgo],
      contents: { [oneYearAgo]: 'Hello past self.' },
    })

    await page.locator('.recollection-card', { hasText: 'Hello past self.' }).first().click()
    const selected = await page.evaluate(() => window.recollectionHarness.selectedDates())
    expect(selected).toEqual([oneYearAgo])
  })

  test('close button reports close', async ({ page }) => {
    await loadHarness(page)
    await render(page, { dates: [oneYearAgo], contents: { [oneYearAgo]: 'x' } })

    await page.locator('.recollection-close').click()
    const count = await page.evaluate(() => window.recollectionHarness.closeCount())
    expect(count).toBe(1)
  })

  test('shows "a while ago" periodic look-back entries', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [oneWeekAgo, oneMonthAgo],
      contents: {
        [oneWeekAgo]: 'A week back, busy days.',
        [oneMonthAgo]: 'A month ago, slower pace.',
      },
    })

    const section = page.locator('.recollection-section', { hasText: 'A while ago' })
    await expect(section).toBeVisible()
    const cards = section.locator('.recollection-card')
    await expect(cards).toHaveCount(2)
    await expect(section).toContainText('A week back')
    await expect(section).toContainText('A month ago')
  })

  test('shows a consecutive-month streak milestone', async ({ page }) => {
    await loadHarness(page)
    const dates = [
      ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      ymd(new Date(now.getFullYear(), now.getMonth() - 1, 10)),
      ymd(new Date(now.getFullYear(), now.getMonth() - 2, 12)),
    ]
    await render(page, { dates })

    const section = page.locator('.recollection-section', { hasText: 'Milestones' })
    await expect(section).toBeVisible()
    await expect(section).toContainText('months in a row')
  })

  test('shows empty state when there is nothing to surface', async ({ page }) => {
    await loadHarness(page)
    // Only today's entry → no past-year matches, no milestones, no random candidate.
    await render(page, { dates: [ymd(now)] })

    await expect(page.locator('.recollection-empty')).toBeVisible()
    await expect(page.locator('.recollection-section')).toHaveCount(0)
  })
})
