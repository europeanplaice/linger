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

// Serendipity candidates: offsets far from any periodic bucket (±10 days of 7d/1m/3m/6m)
// and different month+day from today, so they won't appear in onThisDay or periodic sections.
function dayOffset(days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  return ymd(d)
}
const rand1 = dayOffset(500)
const rand2 = dayOffset(800)
const rand3 = dayOffset(1100)

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/recollectionJourneyHarness.html`)
}

async function render(
  page: import('@playwright/test').Page,
  opts: { dates: string[]; contents?: Record<string, string>; serendipityPrefetch?: string[] },
) {
  await page.evaluate(o => window.recollectionHarness.render(o), opts)
  await page.waitForSelector('.recollection-dialog')
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

  test('shows empty state when there is nothing to surface', async ({ page }) => {
    await loadHarness(page)
    // Only today's entry → no past-year matches, no milestones, no random candidate.
    await render(page, { dates: [ymd(now)] })

    await expect(page.locator('.recollection-empty')).toBeVisible()
    await expect(page.locator('.recollection-section')).toHaveCount(0)
  })

  test('"Meet another day" advances through candidates without repeating', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [rand1, rand2, rand3],
      contents: {
        [rand1]: 'Entry alpha.',
        [rand2]: 'Entry beta.',
        [rand3]: 'Entry gamma.',
      },
    })

    const section = page.locator('.recollection-section', { hasText: 'A day, by chance' })
    const shownDates: string[] = []

    for (let i = 0; i < 3; i++) {
      const dateText = await section.locator('.recollection-card-date').first().innerText()
      shownDates.push(dateText.trim())
      if (i < 2) await section.locator('.recollection-another').click()
    }

    expect(new Set(shownDates).size).toBe(3)
  })

  test('serendipityPrefetch pins specified dates to the front of the queue', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [rand1, rand2, rand3],
      contents: {
        [rand1]: 'Entry alpha.',
        [rand2]: 'Entry beta.',
        [rand3]: 'Entry gamma.',
      },
      serendipityPrefetch: [rand2, rand3],
    })

    const section = page.locator('.recollection-section', { hasText: 'A day, by chance' })

    const first = await section.locator('.recollection-card').first().innerText()
    expect(first).toContain('Entry beta.')

    await section.locator('.recollection-another').click()
    const second = await section.locator('.recollection-card').first().innerText()
    expect(second).toContain('Entry gamma.')
  })

  test('"Meet another day" button disappears after the last candidate', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [rand1, rand2],
      contents: { [rand1]: 'First.', [rand2]: 'Second.' },
    })

    const section = page.locator('.recollection-section', { hasText: 'A day, by chance' })
    await expect(section.locator('.recollection-another')).toBeVisible()

    await section.locator('.recollection-another').click()
    await expect(section.locator('.recollection-another')).toHaveCount(0)
  })
})
