import { test } from '@playwright/test'
import { baseUrl } from './baseUrl'

// Marketing screenshot capture. Skipped in normal/CI runs — regenerate with:
//   CAPTURE_SCREENSHOTS=1 npx playwright test screenshots --project=chromium
// Outputs to public/screenshots/.

test.beforeEach(() => {
  test.skip(!process.env.CAPTURE_SCREENSHOTS, 'screenshot capture only')
})

const entries: Record<string, string> = {
  '2026-06-06': `Woke before the alarm and let the morning stay quiet for once. Coffee on the balcony, the city still half-asleep below. I've been trying to notice the small things lately — the way the light moves across the kitchen floor, the first sip when it's still too hot.

Started reading again last night. Three chapters before I realized how late it was. It felt like remembering something I'd forgotten I loved.

Tomorrow: call Mei, finish the proposal, walk somewhere new.`,
  '2026-06-04': `A long day, but a good one. The meeting ran over and I almost lost my patience, then someone cracked a joke and the whole room softened. Funny how that works.

Made pasta from scratch for the first time. Flour everywhere. Worth it.`,
  '2026-06-03': `Rain all afternoon. I stayed in and finally sorted the photos from the trip. So many I'd forgotten — the harbor at dusk, that ridiculous breakfast, you laughing at something off-camera. Coffee and old pictures. A gentle day.`,
  '2026-06-01': `New month. I want to write here more often, even when nothing happens — especially then. The ordinary days are the ones I forget, and they're most of my life.`,
  '2026-05-28': `Long walk by the river. Coffee from the little cart near the bridge. Thought about how much can change in a year, and how much stays exactly the same.`,
}

const fileMeta = (date: string) => ({
  id: `file-${date}`,
  name: `diary-${date}.txt`,
  version: '1',
  modifiedTime: `${date}T08:00:00.000Z`,
})

async function mockBackend(page: import('@playwright/test').Page) {
  await page.route('**/auth/session', r =>
    r.fulfill({ json: { signedIn: true, email: 'sam@example.com' } }),
  )
  await page.route('**/api/drive/entries', r =>
    r.fulfill({ json: { files: Object.keys(entries).map(fileMeta) } }),
  )
  await page.route('**/api/drive/changes', r =>
    r.fulfill({ json: { changes: [], newStartPageToken: '1' } }),
  )
  await page.route('**/api/drive/migrate', r => r.fulfill({ json: { migrated: 0 } }))
  await page.route('**/api/drive/search**', r => {
    const q = new URL(r.request().url()).searchParams.get('q')?.toLowerCase() ?? ''
    const files = Object.entries(entries)
      .filter(([, c]) => c.toLowerCase().includes(q))
      .map(([d]) => fileMeta(d))
    r.fulfill({ json: { files } })
  })
  await page.route('**/api/drive/entry/**', r => {
    const m = r.request().url().match(/entry\/(\d{4}-\d{2}-\d{2})/)
    const date = m?.[1]
    if (!date || !entries[date]) return r.fulfill({ status: 404, body: '' })
    return r.fulfill({ json: { entry: { date, content: entries[date] }, meta: fileMeta(date) } })
  })
}

test.use({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })

test('capture editor', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('linger_language', 'en'))
  await mockBackend(page)
  await page.goto(baseUrl)
  await page.waitForSelector('.editor-textarea')
  await page.locator('.editor-textarea').waitFor()
  // ensure today's content rendered
  await page.waitForFunction(() => {
    const ta = document.querySelector('.editor-textarea') as HTMLTextAreaElement | null
    return !!ta && ta.value.length > 50
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'public/screenshots/editor.png' })
})

test('capture search', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('linger_language', 'en'))
  await mockBackend(page)
  await page.goto(baseUrl)
  await page.waitForSelector('.editor-textarea')
  const search = page.locator('input[type="search"], .search-bar input').first()
  await search.click()
  await search.fill('coffee')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'public/screenshots/search.png' })
})
