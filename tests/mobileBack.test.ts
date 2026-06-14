import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

function adjacentDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const currentMonth = month - 1
  let next = new Date(year, currentMonth, day + 1)
  if (next.getMonth() !== currentMonth) next = new Date(year, currentMonth, day - 1)

  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    window.localStorage.setItem('linger_language', 'en')
    window.localStorage.setItem('linger_autosave', 'false')
  })
  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: true } })
  })
  await page.route('/api/drive/entries', async route => {
    await route.fulfill({ json: { files: [] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await route.fulfill({ status: 404, body: '' })
  })
  await page.route('/api/drive/milestones', async route => {
    await route.fulfill({ json: [] })
  })
})

test('mobile back closes sidebar instead of leaving the app', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.editor-textarea')).toBeVisible()

  // Set hash to today's date to simulate normal navigation state
  const today = new Date()
  const todayHash = `#${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await page.evaluate((hash) => { window.location.hash = hash }, todayHash)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(todayHash)

  // Open sidebar via menu button
  await page.locator('.btn-menu').click()
  await expect(page.locator('.sidebar')).toHaveClass(/open/)
  await expect(page.locator('.calendar')).toBeVisible()

  // Press back button - should close sidebar (standard behavior)
  await page.goBack()
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(todayHash)

  // Open sidebar again
  await page.locator('.btn-menu').click()
  await expect(page.locator('.sidebar')).toHaveClass(/open/)

  // Press back button again - should close sidebar
  await page.goBack()
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(todayHash)
})

test('entry date does not open the calendar on mobile or desktop', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.editor-textarea')).toBeVisible()
  await expect(page.locator('.entry-date-text')).toBeVisible()
  await expect(page.locator('.entry-date-button')).toHaveCount(0)

  await page.locator('.editor-header h2').click()
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/)

  await page.setViewportSize({ width: 900, height: 700 })
  await page.locator('.editor-header h2').click()
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/)
})

test('mobile date selection confirms before leaving unsaved edits', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.editor-textarea')).toBeVisible()

  const editor = page.locator('.editor-textarea')

  // Set a date hash to simulate normal state
  const today = new Date()
  const currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await page.evaluate((date) => { window.location.hash = '#' + date }, currentDate)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${currentDate}`)

  await editor.fill('unsaved draft')

  // Open sidebar and select a different date
  await page.locator('.btn-menu').click()
  await expect(page.locator('.calendar')).toBeVisible()

  const nextDate = adjacentDate(currentDate)
  await page.getByRole('button', { name: nextDate }).click()
  await expect(page.locator('.unsaved-nav-banner')).toContainText('Unsaved changes')
  await page.locator('.unsaved-nav-banner').getByRole('button', { name: 'Cancel' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${currentDate}`)
  await expect(editor).toHaveValue('unsaved draft')
  await expect(page.locator('.sidebar')).toHaveClass(/open/)

  // Try again and discard changes
  await page.getByRole('button', { name: nextDate }).click()
  await page.locator('.unsaved-nav-banner').getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${nextDate}`)
  await expect(page.locator('.editor-textarea')).toHaveCount(1)
  await expect(editor).toHaveValue('')
})
