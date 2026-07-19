import { expect, test } from '@playwright/test'
import JSZip from 'jszip'
import { baseUrl } from './baseUrl'

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/importButtonHarness.html`)
}

async function render(page: import('@playwright/test').Page, opts: Parameters<typeof window.importButtonHarness.render>[0] = {}) {
  await page.evaluate((o) => window.importButtonHarness.render(o), opts)
}

async function buildZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function uploadZip(page: import('@playwright/test').Page, files: Record<string, string>, name = 'export.zip') {
  const buffer = await buildZip(files)
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/zip', buffer })
}

test.describe('ImportButton', () => {
  test('shows new/skip counts in the confirm dialog after parsing a zip', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: ['2026-05-01'] })

    await uploadZip(page, {
      'diary-2026-05-01.txt': 'already have this one',
      'diary-2026-05-02.txt': 'new entry',
    })

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('1 entries will be added')
    await expect(page.locator('.import-confirm-desc')).toContainText('1 entries already exist')
  })

  test('imports entries and shows a result summary', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      existingDates: [],
      result: { imported: ['2026-05-01', '2026-05-02'], skipped: [], failed: [] },
    })

    await uploadZip(page, {
      'diary-2026-05-01.txt': 'first',
      'diary-2026-05-02.txt': 'second',
    })
    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await page.locator('.import-confirm-start').click()

    await expect(page.locator('.import-confirm-desc')).toContainText('2 added, 0 skipped, 0 failed')

    const calls = await page.evaluate(() => window.importButtonHarness.importCalls())
    expect(calls).toHaveLength(1)
    expect([...calls[0]].sort((a, b) => a.date.localeCompare(b.date))).toEqual([
      { date: '2026-05-01', content: 'first' },
      { date: '2026-05-02', content: 'second' },
    ])
  })

  test('shows partial progress while importing is in flight', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      existingDates: [],
      result: { imported: ['2026-05-01', '2026-05-02'], skipped: [], failed: [] },
      delayMs: 300,
    })

    await uploadZip(page, {
      'diary-2026-05-01.txt': 'a',
      'diary-2026-05-02.txt': 'b',
    })
    await page.locator('.import-confirm-start').click()

    // Verify progress callbacks were fired during import via the harness
    await expect.poll(async () => {
      const calls = await page.evaluate(() => window.importButtonHarness.progressCalls())
      return calls.some(p => p.done >= 1 && p.total === 2)
    }).toBe(true)
    await expect(page.locator('.import-confirm-desc')).toContainText('2 added, 0 skipped, 0 failed')
  })

  test('strips legacy frontmatter from .md entries and reads nested zip paths', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [] })

    await uploadZip(page, {
      'linger_diary/diary-2020-01-01.md': '---\ndate: 2020-01-01\n---\nold entry body',
    }, 'drive-folder.zip')

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('1 entries will be added')

    await page.locator('.import-confirm-start').click()
    await expect.poll(async () => (await page.evaluate(() => window.importButtonHarness.importCalls())).length).toBe(1)
    const calls = await page.evaluate(() => window.importButtonHarness.importCalls())
    expect(calls[0]).toEqual([{ date: '2020-01-01', content: 'old entry body' }])
  })

  test('ignores non-diary files inside the zip', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [] })

    await uploadZip(page, {
      '.DS_Store': '',
      'milestones.json': '{}',
      'diary-2026-05-01.txt': 'kept',
    }, 'mixed.zip')

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('1 entries will be added')
    await expect(page.locator('.import-confirm-desc')).toContainText('0 entries already exist')
  })

  test('shows an error when the zip has no diary entries', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [] })

    await uploadZip(page, { 'readme.txt': 'nothing here' }, 'empty.zip')

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('No diary entries or milestones were found')
  })

  test('shows an error for a file that is not a valid zip', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [] })

    await page.locator('input[type=file]').setInputFiles({
      name: 'not-a-zip.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a zip file'),
    })

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('Could not read this file')
  })

  test('cancel closes the dialog without importing', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [] })

    await uploadZip(page, { 'diary-2026-05-01.txt': 'entry' })
    await expect(page.locator('.import-confirm-dialog')).toBeVisible()

    await page.locator('.import-confirm-cancel').click()
    await expect(page.locator('.import-confirm-dialog')).not.toBeVisible()
    expect(await page.evaluate(() => window.importButtonHarness.importCalls())).toHaveLength(0)
  })

  test('resets to idle if onImport rejects (e.g. session expiry)', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [], reject: true })

    await uploadZip(page, { 'diary-2026-05-01.txt': 'entry' })
    await page.locator('.import-confirm-start').click()

    await expect(page.locator('.import-confirm-dialog')).not.toBeVisible()
    await expect(page.locator('.btn-import-modern')).toBeEnabled()
  })

  test('detects milestones.json and shows new/skip counts in the confirm dialog', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      existingDates: [],
      existingMilestones: [{ id: 'a', label: 'Birthday', date: '2020-01-01' }],
    })

    await uploadZip(page, {
      'milestones.json': JSON.stringify([
        { id: 'old-1', label: 'Birthday', date: '2020-01-01' },
        { id: 'old-2', label: 'Anniversary', date: '2021-02-14' },
      ]),
    })

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('1 milestones will also be added')
    await expect(page.locator('.import-confirm-desc')).toContainText('1 already exist')
  })

  test('imports milestones and shows a milestone result summary', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      existingDates: [],
      existingMilestones: [],
      milestoneResult: { imported: 2, skipped: 0 },
    })

    await uploadZip(page, {
      'milestones.json': JSON.stringify([
        { id: 'old-1', label: 'Birthday', date: '2020-01-01', emoji: '🎂' },
        { id: 'old-2', label: 'Anniversary', date: '2021-02-14', recurring: true },
      ]),
    })
    await page.locator('.import-confirm-start').click()

    await expect(page.locator('.import-confirm-desc')).toContainText('Milestones: 2 added, 0 skipped')

    const calls = await page.evaluate(() => window.importButtonHarness.milestoneImportCalls())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      { id: 'old-1', label: 'Birthday', date: '2020-01-01', emoji: '🎂' },
      { id: 'old-2', label: 'Anniversary', date: '2021-02-14', recurring: true },
    ])
  })

  test('prefers milestones.json over the legacy anniversaries.json when both are present', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [], existingMilestones: [] })

    await uploadZip(page, {
      'anniversaries.json': JSON.stringify([{ id: 'legacy-1', label: 'Legacy one', date: '2019-01-01' }]),
      'milestones.json': JSON.stringify([{ id: 'current-1', label: 'Current one', date: '2020-01-01' }]),
    })
    await page.locator('.import-confirm-start').click()

    const calls = await page.evaluate(() => window.importButtonHarness.milestoneImportCalls())
    expect(calls[0]).toEqual([{ id: 'current-1', label: 'Current one', date: '2020-01-01' }])
  })

  test('falls back to the legacy anniversaries.json when milestones.json is absent', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [], existingMilestones: [] })

    await uploadZip(page, {
      'anniversaries.json': JSON.stringify([{ id: 'legacy-1', label: 'Legacy one', date: '2019-01-01' }]),
    })
    await page.locator('.import-confirm-start').click()

    const calls = await page.evaluate(() => window.importButtonHarness.milestoneImportCalls())
    expect(calls[0]).toEqual([{ id: 'legacy-1', label: 'Legacy one', date: '2019-01-01' }])
  })

  test('accepts a zip containing only milestones, with no diary entries section shown', async ({ page }) => {
    await loadHarness(page)
    await render(page, { existingDates: [], existingMilestones: [] })

    await uploadZip(page, {
      'milestones.json': JSON.stringify([{ id: 'a', label: 'Birthday', date: '2020-01-01' }]),
    })

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    await expect(page.locator('.import-confirm-desc')).toContainText('1 milestones will also be added')
    await expect(page.locator('.import-confirm-desc')).not.toContainText('entries will be added')

    await page.locator('.import-confirm-start').click()
    await expect(page.locator('.import-confirm-desc')).toContainText('Milestones:')
    const diaryCalls = await page.evaluate(() => window.importButtonHarness.importCalls())
    expect(diaryCalls).toHaveLength(0)
  })

  test('ignores a corrupt milestones.json without failing the whole import', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      existingDates: [],
      existingMilestones: [],
      result: { imported: ['2026-05-01'], skipped: [], failed: [] },
    })

    await uploadZip(page, {
      'diary-2026-05-01.txt': 'entry',
      'milestones.json': 'not valid json{{{',
    })

    await expect(page.locator('.import-confirm-dialog')).toBeVisible()
    // Corrupt milestones file yields zero parsed milestones, so only the diary line shows.
    await expect(page.locator('.import-confirm-desc')).toContainText('1 entries will be added')
    await expect(page.locator('.import-confirm-desc')).not.toContainText('milestones will also be added')

    await page.locator('.import-confirm-start').click()
    await expect(page.locator('.import-confirm-desc')).toContainText('1 added, 0 skipped, 0 failed')
    const milestoneCalls = await page.evaluate(() => window.importButtonHarness.milestoneImportCalls())
    expect(milestoneCalls).toHaveLength(0)
  })
})
