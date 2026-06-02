import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

// ── Theme token resolution ────────────────────────────────────────────────────
// These tests catch the common regression where a developer hardcodes a color
// (e.g. #33312e) instead of using var(--token), breaking dark mode silently.

test.describe('Design regression — theme token resolution', () => {
  test('calendar dark theme recolors text and resolves different tokens', async ({ page }) => {
    await page.goto(`${baseUrl}/tests/calendarViewHarness.html`)
    const lightColor = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.calendar-grid') as HTMLElement).color
    )

    await page.goto(`${baseUrl}/tests/calendarViewHarness.html?theme=dark`)
    const { darkColor, darkToken } = await page.evaluate(() => ({
      darkColor: getComputedStyle(document.querySelector('.calendar-grid') as HTMLElement).color,
      darkToken: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
    }))

    // Dark --text token must be defined and the rendered color must differ from light
    expect(darkToken).not.toBe('')
    expect(darkColor).not.toBe(lightColor)
  })

  test('today ring color token differs between light and dark', async ({ page }) => {
    await page.goto(`${baseUrl}/tests/calendarViewHarness.html`)
    const lightToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--today-ring').trim()
    )

    await page.goto(`${baseUrl}/tests/calendarViewHarness.html?theme=dark`)
    const darkToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--today-ring').trim()
    )

    expect(lightToken).not.toBe('')
    expect(darkToken).not.toBe('')
    expect(darkToken).not.toBe(lightToken)
  })

  test('conflict panel uses --conflict-bg token in dark theme', async ({ page }) => {
    for (const theme of ['', '?theme=dark']) {
      await page.goto(`${baseUrl}/tests/entryEditorHarness.html${theme}`)
      await page.evaluate(() =>
        window.editorHarness.render({
          date: '2026-05-01',
          initialContent: 'base',
          version: '1',
          saveReject: 'conflict',
          autoSave: false,
          token: 'tok',
        })
      )
      await page.waitForSelector('textarea.editor-textarea')
      await page.locator('textarea.editor-textarea').fill('local edit')
      await page.keyboard.press('Control+s')
      await page.waitForSelector('.conflict-panel')

      const { panelBg, tokenBg } = await page.evaluate(() => ({
        panelBg: getComputedStyle(document.querySelector('.conflict-panel') as HTMLElement).backgroundColor,
        tokenBg: getComputedStyle(document.documentElement).getPropertyValue('--conflict-bg').trim(),
      }))

      // Token is defined and the panel has a visible (non-transparent) background
      expect(tokenBg, `--conflict-bg should be set in theme: ${theme || 'light'}`).not.toBe('')
      expect(panelBg, 'conflict panel should have a visible background').not.toBe('rgba(0, 0, 0, 0)')
      expect(panelBg).not.toBe('transparent')
    }
  })
})

// ── Calendar structure ────────────────────────────────────────────────────────

test.describe('Design regression — calendar structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseUrl}/tests/calendarViewHarness.html`)
  })

  test('calendar grid renders 7 equal-width columns', async ({ page }) => {
    const cols = await page.locator('.calendar-grid').evaluate(
      el => getComputedStyle(el).gridTemplateColumns
    )
    // Computed value is resolved px widths (e.g. "38.8px 38.8px ...")
    const widths = cols.split(' ').map(parseFloat)
    expect(widths).toHaveLength(7)
    const [first] = widths
    for (const w of widths) expect(Math.abs(w - first)).toBeLessThan(1.5)
  })

  test('today ring is a box-shadow using --today-ring token, not an outline', async ({ page }) => {
    const { year, month, dateStr } = await page.evaluate(() => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      return {
        year: d.getFullYear(),
        month: d.getMonth(),
        dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      }
    })
    await page.getByLabel('Select year').selectOption(String(year))
    await page.getByLabel('Select month').selectOption(String(month))

    const todayCell = page.getByRole('button', { name: dateStr })
    await expect(todayCell).toHaveClass(/today/)

    const { boxShadow, outlineStyle, ringToken } = await todayCell.evaluate(el => ({
      boxShadow: getComputedStyle(el).boxShadow,
      outlineStyle: getComputedStyle(el).outlineStyle,
      ringToken: getComputedStyle(document.documentElement).getPropertyValue('--today-ring').trim(),
    }))

    // Ring must be box-shadow (inset) so overflow:hidden on the grid wrapper does not clip it
    expect(boxShadow).not.toBe('none')
    expect(boxShadow).not.toBe('')
    expect(outlineStyle).toBe('none')
    expect(ringToken).not.toBe('')
  })

  test('entry dot is present on dates with entries', async ({ page }) => {
    // 2026-03-10 has an entry (seeded in harness); navigate to that month
    await page.getByLabel('Select year').selectOption('2026')
    await page.getByLabel('Select month').selectOption('2') // March (0-indexed)
    const cell = page.getByRole('button', { name: '2026-03-10' })
    await expect(cell).toHaveClass(/has-entry/)
    // The dot pseudo-element cannot be queried directly, but the class controls it
    const dotColor = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--dot').trim()
    )
    expect(dotColor).not.toBe('')
  })
})

// ── Entry editor states ───────────────────────────────────────────────────────

test.describe('Design regression — entry editor states', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseUrl}/tests/entryEditorHarness.html`)
  })

  test('loading skeleton rows have shimmer animation and token-driven background', async ({ page }) => {
    await page.evaluate(() =>
      window.editorHarness.render({ date: '2026-04-01', getContentDelayMs: 5000 })
    )

    const skeleton = page.locator('.entry-skeleton')
    await expect(skeleton).toBeVisible()
    await expect(page.locator('.entry-skeleton-row').first()).toBeVisible()

    const { hasBackground, hasAnimation, rowToken } = await page
      .locator('.entry-skeleton-row')
      .first()
      .evaluate(el => {
        const s = getComputedStyle(el)
        return {
          hasBackground: s.backgroundColor !== 'rgba(0, 0, 0, 0)',
          hasAnimation: s.animationName !== 'none',
          rowToken: getComputedStyle(document.documentElement).getPropertyValue('--skeleton-row-bg').trim(),
        }
      })

    expect(hasBackground).toBe(true)
    expect(hasAnimation).toBe(true)
    expect(rowToken).not.toBe('')
  })

  test('unsaved indicator appears when the entry is modified', async ({ page }) => {
    await page.evaluate(() =>
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'original',
        version: '1',
        autoSave: false,
        token: 'tok',
      })
    )
    await page.waitForSelector('textarea.editor-textarea')
    await page.locator('textarea.editor-textarea').fill('modified')
    await expect(page.locator('.editor-meta-unsaved')).toBeVisible()
  })
})
