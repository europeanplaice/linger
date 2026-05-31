import { expect, test, type Download } from '@playwright/test'
import JSZip from 'jszip'
import { baseUrl } from './baseUrl'

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/exportButtonHarness.html`)
  await page.evaluate(() => window.exportButtonHarness.render())
  await page.waitForSelector('.btn-export-modern')
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream()
  expect(stream).not.toBeNull()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

test.describe('ExportButton', () => {
  test('downloads a zip containing diary txt files with storage content', async ({ page }) => {
    await loadHarness(page)

    await page.locator('.btn-export-modern').click()
    await expect(page.locator('.export-confirm-dialog')).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.locator('.export-confirm-start').click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toMatch(/^linger_diary_export_\d{4}-\d{2}-\d{2}\.zip$/)
    expect(await page.evaluate(() => window.exportButtonHarness.exportCalls())).toBe(1)
    expect(await page.evaluate(() => window.exportButtonHarness.progressCalls())).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])

    const zip = await JSZip.loadAsync(await readDownload(download))

    expect(Object.keys(zip.files).sort()).toEqual([
      'diary-2026-05-01.txt',
      'diary-2026-05-02.txt',
    ])
    expect(await zip.file('diary-2026-05-01.txt')?.async('string')).toBe('first entry')
    expect(await zip.file('diary-2026-05-02.txt')?.async('string')).toBe('second entry')
  })
})
