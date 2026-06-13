import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.beforeEach(async ({ page }) => {
  await page.goto(`${baseUrl}/tests/calendarViewHarness.html`)
})

test.describe('CalendarView', () => {
  test('uses regular month navigation and can jump to today', async ({ page }) => {
    const monthSelect = page.getByLabel('Select month')

    await expect(monthSelect).toHaveValue('3')

    await page.getByRole('button', { name: 'Next month' }).click()
    await expect(monthSelect).toHaveValue('4')

    await page.getByRole('button', { name: 'Previous month' }).click()
    await expect(monthSelect).toHaveValue('3')

    await page.getByRole('button', { name: 'Today' }).click()
    const expectedMonth = await page.evaluate(() => String(new Date().getMonth()))
    const expectedYear = await page.evaluate(() => String(new Date().getFullYear()))

    await expect(monthSelect).toHaveValue(expectedMonth)
    await expect(page.getByLabel('Select year')).toHaveValue(expectedYear)
  })

  test('selects days by click and keyboard activation', async ({ page }) => {
    await page.getByRole('button', { name: '2026-04-14' }).click()
    await page.getByRole('button', { name: '2026-04-15' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '2026-04-16' }).focus()
    await page.keyboard.press('Space')

    expect(await page.evaluate(() => window.calendarHarness.selectedDates())).toEqual([
      '2026-04-14',
      '2026-04-15',
      '2026-04-16',
    ])
  })

  test('marks entry and selected day states', async ({ page }) => {
    await page.getByLabel('Select month').selectOption('2')

    await expect(page.getByRole('button', { name: '2026-03-10' })).toHaveClass(/has-entry/)
    await expect(page.getByRole('button', { name: '2026-03-10' })).not.toHaveClass(/selected/)

    await page.getByLabel('Select month').selectOption('3')
    await expect(page.getByRole('button', { name: '2026-04-14' })).toHaveClass(/selected/)
  })

  test('calendar grid is inside an overflow-hidden wrapper for slide animation', async ({ page }) => {
    const wrap = page.locator('.calendar-grid-wrap')
    await expect(wrap).toBeVisible()
    // Grid is a direct child of the wrapper
    await expect(wrap.locator('> .calendar-grid')).toBeVisible()

    const overflow = await wrap.evaluate(el => getComputedStyle(el).overflow)
    expect(overflow).toBe('hidden')
  })

  test('month navigation via select still works after animation wrapper added', async ({ page }) => {
    const monthSelect = page.getByLabel('Select month')

    await monthSelect.selectOption('5') // June
    await expect(monthSelect).toHaveValue('5')
    // After exit animation completes, exactly one grid should remain
    await expect(page.locator('.calendar-grid')).toHaveCount(1)

    await monthSelect.selectOption('1') // February
    await expect(monthSelect).toHaveValue('1')
    await expect(page.locator('.calendar-grid')).toHaveCount(1)
  })

  test('today cell uses inset box-shadow ring instead of outline', async ({ page }) => {
    // Navigate to today's month so the today cell is present
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

    // Ring must be box-shadow (inset), not outline — outline gets clipped by overflow:hidden
    // on the grid wrapper when today falls on Sunday (leftmost column)
    const boxShadow = await todayCell.evaluate(el => getComputedStyle(el).boxShadow)
    expect(boxShadow).not.toBe('none')
    expect(boxShadow).not.toBe('')

    const outlineStyle = await todayCell.evaluate(el => getComputedStyle(el).outlineStyle)
    expect(outlineStyle).toBe('none')
  })
})
