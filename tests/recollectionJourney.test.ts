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
const rand4 = dayOffset(1400)
const rand5 = dayOffset(1700)

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/recollectionJourneyHarness.html`)
}

async function render(
  page: import('@playwright/test').Page,
  opts: { dates: string[]; contents?: Record<string, string>; serendipityPrefetch?: string[]; getSimilar?: (date: string, limit?: number) => string[] },
) {
  await page.evaluate(o => window.recollectionHarness.render(o), opts)
  await page.waitForSelector('.recollection-dialog')
}

test.describe('RecollectionJourney', () => {
  // Pin the browser clock to match the module-level `now` so the component's
  // internal "today" never diverges from the fixture dates at midnight.
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: now })
  })

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

  test('"Meet another day" keeps card height stable across snippet lengths', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [rand1, rand2, rand3],
      contents: {
        [rand1]: 'Tiny.',
        [rand2]: 'This entry has enough words to wrap across multiple lines in the recollection card preview, showing the longer text path without changing the surrounding layout.',
        [rand3]: 'Another entry.',
      },
      serendipityPrefetch: [rand1, rand2, rand3],
    })

    const section = page.locator('.recollection-section', { hasText: 'A day, by chance' })
    const card = section.locator('.recollection-card').first()
    await expect(card).toContainText('Tiny.')
    const firstBox = await card.boundingBox()

    await section.locator('.recollection-another').click()
    await expect(card).toContainText('This entry has enough words')
    const secondBox = await card.boundingBox()

    expect(firstBox).not.toBeNull()
    expect(secondBox).not.toBeNull()
    expect(Math.abs(firstBox!.height - secondBox!.height)).toBeLessThan(1)
  })

  test('prefetches the next 3 random entries on render, then the 4th after advancing', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      dates: [rand1, rand2, rand3, rand4, rand5],
      contents: {
        [rand1]: 'Entry one.',
        [rand2]: 'Entry two.',
        [rand3]: 'Entry three.',
        [rand4]: 'Entry four.',
        [rand5]: 'Entry five.',
      },
      serendipityPrefetch: [rand1, rand2, rand3, rand4, rand5],
    })

    // current (rand1) + next 3 (rand2–rand4) should be fetched; rand5 not yet
    await expect.poll(() => page.evaluate(() => window.recollectionHarness.getContentCalls()))
      .toEqual(expect.arrayContaining([rand1, rand2, rand3, rand4]))
    expect(await page.evaluate(() => window.recollectionHarness.getContentCalls())).not.toContain(rand5)

    // after advancing to rand2, rand5 (idx+3 from the new position) should be prefetched
    const section = page.locator('.recollection-section', { hasText: 'A day, by chance' })
    await section.locator('.recollection-another').click()

    await expect.poll(() => page.evaluate(() => window.recollectionHarness.getContentCalls()))
      .toContain(rand5)
  })

  test('records the shown serendipity date to localStorage (avoids déjà-vu next open)', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => localStorage.removeItem('linger_serendipity_seen'))
    await render(page, {
      dates: [rand1, rand2, rand3],
      contents: { [rand1]: 'Entry alpha.', [rand2]: 'Entry beta.', [rand3]: 'Entry gamma.' },
    })

    const section = page.locator('.recollection-section', { hasText: 'A day, by chance' })
    await expect(section).toBeVisible()

    const readSeen = () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('linger_serendipity_seen') || '[]') as { date: string }[])

    // The first surfaced day is recorded.
    await expect.poll(() => readSeen().then(s => s.length)).toBeGreaterThan(0)
    const first = await readSeen()
    expect([rand1, rand2, rand3]).toContain(first[0].date)

    // Advancing records the next day too (newest first, distinct).
    await section.locator('.recollection-another').click()
    await expect.poll(() => readSeen().then(s => s.length)).toBeGreaterThanOrEqual(2)
    const after = await readSeen()
    expect(after[0].date).not.toBe(first[0].date)
  })

  test('"Similar days" heading names the serendipity date and updates when advancing', async ({ page }) => {
    await loadHarness(page)

    // Inject getSimilar into the browser before calling render —
    // page.evaluate cannot serialize functions as arguments.
    await page.evaluate(([r1, r2, r3, r4]: string[]) => {
      ;(window as Window & { __testGetSimilar__?: (date: string) => string[] }).__testGetSimilar__ =
        (date: string) => date === r1 ? [r3] : date === r2 ? [r4] : []
    }, [rand1, rand2, rand3, rand4])

    await page.evaluate(
      ([dates, contents, prefetch]: [string[], Record<string, string>, string[]]) => {
        const w = window as Window & { __testGetSimilar__?: (date: string) => string[] }
        window.recollectionHarness.render({ dates, contents, serendipityPrefetch: prefetch, getSimilar: w.__testGetSimilar__ })
      },
      [
        [rand1, rand2, rand3, rand4],
        { [rand1]: 'Entry alpha.', [rand2]: 'Entry beta.', [rand3]: 'Entry gamma.', [rand4]: 'Entry delta.' },
        [rand1, rand2],
      ] as [string[], Record<string, string>, string[]],
    )
    await page.waitForSelector('.recollection-dialog')

    // Compute expected labels using local-date parsing (same as the component's dateFromYmd).
    // omitCurrentYear=true: rand1/rand2 are 500/800 days old — always a different year from now.
    function localDateLabel(ymdStr: string): string {
      const [y, m, d] = ymdStr.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    }

    // The heading is now dynamic ("Days like <date>"), so locate by the glyph ≈
    const similarSection = page.locator('.recollection-section', { hasText: '≈' })
    await expect(similarSection).toBeVisible()

    // Heading should reference the current serendipity date (rand1)
    await expect(similarSection.locator('.recollection-section-heading')).toContainText(`Days like ${localDateLabel(rand1)}`)

    // Advancing serendipity should update the heading to reference rand2
    const serendipitySection = page.locator('.recollection-section', { hasText: 'A day, by chance' })
    await serendipitySection.locator('.recollection-another').click()

    await expect(similarSection.locator('.recollection-section-heading')).toContainText(`Days like ${localDateLabel(rand2)}`)
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
