import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

const currentDate = '2026-01-01'
const milestoneDate = '2020-05-10'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('linger_language', 'en')
    localStorage.setItem('linger_autosave', 'false')
  })
  await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true } }))
  await page.route('/api/drive/entries', route => route.fulfill({
    json: {
      files: [
        { id: 'current-file', name: `diary-${currentDate}.txt`, version: '1' },
        { id: 'milestone-file', name: `diary-${milestoneDate}.txt`, version: '1' },
      ],
    },
  }))
  await page.route('/api/drive/milestones', route => route.fulfill({
    json: [
      { id: 'birthday', label: 'Birthday', date: milestoneDate },
    ],
  }))
  await page.route('/api/drive/entry/**', route => {
    const date = new URL(route.request().url()).pathname.split('/').pop()
    const content = date === milestoneDate ? 'Milestone entry' : 'Current entry'
    return route.fulfill({
      json: {
        entry: { date, content },
        meta: { id: `${date}-file`, name: `diary-${date}.txt`, version: '1' },
      },
    })
  })
})

test('clicking a milestone badge opens its entry', async ({ page }) => {
  await page.goto(`${baseUrl}/#${currentDate}`)
  await expect(page.locator('.editor-textarea')).toHaveValue('Current entry')

  await page.getByRole('button', { name: `Open Birthday entry for ${milestoneDate}` }).click()

  await expect(page).toHaveURL(new RegExp(`#${milestoneDate}$`))
  await expect.poll(() => page.locator('.editor-textarea').count()).toBe(1)
  await expect(page.locator('.editor-textarea')).toHaveValue('Milestone entry')
})

test('milestone navigation uses the unsaved-changes guard', async ({ page }) => {
  await page.goto(`${baseUrl}/#${currentDate}`)
  const editor = page.locator('.editor-textarea')
  await expect(editor).toHaveValue('Current entry')
  await editor.fill('Unsaved current entry')

  await page.getByRole('button', { name: `Open Birthday entry for ${milestoneDate}` }).click()

  await expect(page).toHaveURL(new RegExp(`#${currentDate}$`))
  const banner = page.locator('.unsaved-nav-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Discard' }).click()

  await expect(page).toHaveURL(new RegExp(`#${milestoneDate}$`))
  await expect.poll(() => page.locator('.editor-textarea').count()).toBe(1)
  await expect(page.locator('.editor-textarea')).toHaveValue('Milestone entry')
})
