import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

const REV_LIST = {
  revisions: [
    { id: 'rev-3', modifiedTime: '2026-05-01T12:59:00.000Z' },
    { id: 'rev-2', modifiedTime: '2026-05-01T11:00:00.000Z' },
    { id: 'rev-1', modifiedTime: '2026-05-01T10:00:00.000Z' },
  ],
}

const CONTENT_V3 = { date: '2026-05-01', content: 'latest version text', updated_at: '2026-05-01T13:00:00.000Z' }
const CONTENT_V2 = { date: '2026-05-01', content: 'older version text', updated_at: '2026-05-01T12:00:00.000Z' }
const CONTENT_V1 = { date: '2026-05-01', content: 'oldest version text', updated_at: '2026-05-01T11:00:00.000Z' }

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/historyModalHarness.html`)
}

async function renderModal(
  page: import('@playwright/test').Page,
  opts: { date?: string; fileId?: string; baseVersion?: string | null; text?: string; savedText?: string; isDirty?: boolean; autoSave?: boolean } = {},
) {
  // Content for every revision is provided up front; the modal prefetches all of
  // them on open, so switching versions later is served from cache.
  await page.evaluate(({ revList, c3, c2, c1, opts }) => {
    window.historyHarness.list({ status: 200, body: revList })
    window.historyHarness.content({
      'rev-3': { status: 200, body: c3 },
      'rev-2': { status: 200, body: c2 },
      'rev-1': { status: 200, body: c1 },
    })
    window.historyHarness.render(opts)
  }, { revList: REV_LIST, c3: CONTENT_V3, c2: CONTENT_V2, c1: CONTENT_V1, opts })
  await page.waitForSelector('.history-preview-diff')
}

test.describe('HistoryModal — revision list', () => {
  test('shows all revisions after loading', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    const items = page.locator('.history-revision-item')
    await expect(items).toHaveCount(3)
  })

  test('shows "Current" badge only on the first (newest) revision', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await expect(page.locator('.history-revision-item').first().locator('.history-revision-badge')).toHaveText('Current')
    await expect(page.locator('.history-revision-item').nth(1).locator('.history-revision-badge')).toHaveCount(0)
    await expect(page.locator('.history-revision-item').nth(2).locator('.history-revision-badge')).toHaveCount(0)
  })

  test('first revision is selected by default', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await expect(page.locator('.history-revision-item').first()).toHaveClass(/selected/)
    await expect(page.locator('.history-revision-item').nth(1)).not.toHaveClass(/selected/)
  })

  test('shows revision timestamps', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(({ content }) => {
      const now = new Date()
      const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime()
      window.historyHarness.list({ status: 200, body: { revisions: [
        { id: 'rev-2', modifiedTime: new Date(todayNoon - 60_000).toISOString() },
        { id: 'rev-1', modifiedTime: new Date(todayNoon - 3_600_000).toISOString() },
      ] } })
      window.historyHarness.content({
        'rev-2': { status: 200, body: content },
        'rev-1': { status: 200, body: content },
      })
      window.historyHarness.render()
    }, { content: CONTENT_V3 })
    await page.waitForSelector('.history-preview-diff')

    const firstTime = await page.locator('.history-revision-item').first().locator('.history-revision-time').textContent()
    expect(firstTime).toMatch(/Today/)
  })

  test('shows skeleton while list is loading', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(({ revList, c3, c2, c1 }) => {
      window.historyHarness.list({ status: 200, body: revList, delayMs: 300 })
      window.historyHarness.content({
        'rev-3': { status: 200, body: c3 },
        'rev-2': { status: 200, body: c2 },
        'rev-1': { status: 200, body: c1 },
      })
      window.historyHarness.render()
    }, { revList: REV_LIST, c3: CONTENT_V3, c2: CONTENT_V2, c1: CONTENT_V1 })

    await expect(page.locator('.history-skeleton-row').first()).toBeVisible()
    await page.waitForSelector('.history-revision-item')
    await expect(page.locator('.history-skeleton-row')).toHaveCount(0)
  })
})

test.describe('HistoryModal — preview', () => {
  test('preview shows content of the selected revision', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    // diffWords highlights changed words; the full current content should be visible
    await expect(page.locator('.history-preview-diff')).toContainText(CONTENT_V3.content)
  })

  test('clicking a prefetched revision shows its content instantly without a skeleton', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    // Wait for all revisions to be prefetched so the next selection is a cache hit.
    await expect.poll(async () => {
      const urls = (await page.evaluate(() => window.historyHarness.calls())).map(c => c.url)
      return ['rev-3', 'rev-2', 'rev-1'].every(id => urls.includes(`/api/drive/revisions/file-123/${id}`))
    }).toBe(true)

    await page.locator('.history-revision-item').nth(1).click()

    await expect(page.locator('.history-revision-item').nth(1)).toHaveClass(/selected/)
    // Prefetched content renders synchronously — the loading skeleton must never appear.
    await expect(page.locator('.history-preview-skeleton')).toHaveCount(0)
    await expect(page.locator('.history-preview-diff')).toContainText(CONTENT_V2.content)
  })

  test('shows preview skeleton while content is loading', async ({ page }) => {
    await loadHarness(page)

    // List is fast, but the selected revision's content is delayed.
    await page.evaluate(({ revList, c3, c2, c1 }) => {
      window.historyHarness.list({ status: 200, body: revList })
      window.historyHarness.content({
        'rev-3': { status: 200, body: c3, delayMs: 300 },
        'rev-2': { status: 200, body: c2 },
        'rev-1': { status: 200, body: c1 },
      })
      window.historyHarness.render()
    }, { revList: REV_LIST, c3: CONTENT_V3, c2: CONTENT_V2, c1: CONTENT_V1 })

    await page.waitForSelector('.history-revision-item')
    await expect(page.locator('.history-preview-skeleton')).toBeVisible()
    await page.waitForSelector('.history-preview-diff')
    await expect(page.locator('.history-preview-skeleton')).toHaveCount(0)
  })

  test('prefetches content for all revisions on open', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, { fileId: 'my-file-id' })

    await expect.poll(async () => {
      const urls = (await page.evaluate(() => window.historyHarness.calls())).map(c => c.url)
      return ['rev-3', 'rev-2', 'rev-1'].every(id => urls.includes(`/api/drive/revisions/my-file-id/${id}`))
    }).toBe(true)
  })

  test('shows error when preview fetch fails', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(({ revList }) => {
      window.historyHarness.list({ status: 200, body: revList })
      window.historyHarness.content({ 'rev-3': { status: 500, body: { error: 'Server error' } } })
      window.historyHarness.render()
    }, { revList: REV_LIST })

    await page.waitForSelector('.history-preview-error')
    await expect(page.locator('.history-preview-error')).toContainText('Failed to load')
  })

  test('renders non-diff preview content as text, not HTML', async ({ page }) => {
    await loadHarness(page)

    const maliciousContent = '<img src=x onerror="window.__historyXss = true">plain text'
    await page.evaluate(({ content }) => {
      window.__historyXss = false
      window.historyHarness.list({ status: 200, body: { revisions: [{ id: 'rev-1', modifiedTime: new Date().toISOString() }] } })
      window.historyHarness.content({ 'rev-1': { status: 200, body: { date: '2026-05-01', content, updated_at: new Date().toISOString() } } })
      window.historyHarness.render()
    }, { content: maliciousContent })

    const preview = page.locator('.history-preview-diff')
    await expect(preview).toContainText(maliciousContent)
    await expect(preview.locator('img')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__historyXss)).toBe(false)
  })
})

test.describe('HistoryModal — restore button', () => {
  test('restore button is disabled for the current (newest) revision', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await expect(page.locator('.btn-restore')).toBeDisabled()
  })

  test('restore button is enabled for older revisions', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')

    await expect(page.locator('.btn-restore')).toBeEnabled()
  })

  test('restore calls onSave with the selected content and closes modal', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, { baseVersion: '7', savedText: 'current saved content' })

    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')

    await page.locator('.btn-restore').click()
    await page.waitForSelector('#modal-closed')

    const saveCalls = await page.evaluate(() => window.historyHarness.saveCalls())
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].content).toBe(CONTENT_V2.content)
    expect(saveCalls[0].date).toBe('2026-05-01')
    const [fullSaveCall] = await page.evaluate(() => window.historyHarness.saveCallsWithBaseContent())
    expect(fullSaveCall).toMatchObject({
      content: CONTENT_V2.content,
      baseVersion: '7',
      baseContent: 'current saved content',
    })

    const restoredCalls = await page.evaluate(() => window.historyHarness.restoredCalls())
    expect(restoredCalls).toHaveLength(1)
  })

  test('restore shows conflict error without closing modal', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')

    await page.evaluate(() => window.historyHarness.setSaveReject('conflict'))
    await page.locator('.btn-restore').click()

    await expect(page.locator('.history-restore-error')).toBeVisible()
    await expect(page.locator('.history-dialog')).toBeVisible()
  })

  test('restore shows error message on save failure', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')

    await page.evaluate(() => window.historyHarness.setSaveReject('error'))
    await page.locator('.btn-restore').click()

    await expect(page.locator('.history-restore-error')).toBeVisible()
  })

  test('restore button is disabled when the selected version failed to load', async ({ page }) => {
    await loadHarness(page)

    // rev-2 loads fine; rev-1 (oldest) fails. We select rev-2 first to ensure
    // previewContent is set from a prior successful load, then switch to rev-1
    // to verify the button becomes disabled even with stale content in state.
    await page.evaluate(({ revList, c3, c2 }) => {
      window.historyHarness.list({ status: 200, body: revList })
      window.historyHarness.content({
        'rev-3': { status: 200, body: c3 },
        'rev-2': { status: 200, body: c2 },
        'rev-1': { status: 500, body: { error: 'Server error' } },
      })
      window.historyHarness.render()
    }, { revList: REV_LIST, c3: CONTENT_V3, c2: CONTENT_V2 })

    // Select rev-2 first so previewContent is populated with stale content
    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')
    await expect(page.locator('.btn-restore')).toBeEnabled()

    // Now select rev-1 which fails to load
    await page.locator('.history-revision-item').nth(2).click()
    await page.waitForSelector('.history-preview-error')

    await expect(page.locator('.btn-restore')).toBeDisabled()
  })
})

test.describe('HistoryModal — close behaviour', () => {
  test('× button closes the modal', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.locator('.history-modal-close').click()
    await page.waitForSelector('#modal-closed')

    const closeCalls = await page.evaluate(() => window.historyHarness.closeCalls())
    expect(closeCalls).toBe(1)
  })

  test('Escape key closes the modal', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.keyboard.press('Escape')
    await page.waitForSelector('#modal-closed')

    const closeCalls = await page.evaluate(() => window.historyHarness.closeCalls())
    expect(closeCalls).toBe(1)
  })

  test('clicking the overlay closes the modal', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.mouse.click(10, 10)
    await page.waitForSelector('#modal-closed')

    const closeCalls = await page.evaluate(() => window.historyHarness.closeCalls())
    expect(closeCalls).toBe(1)
  })

  test('clicking inside the modal does not close it', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    await page.locator('.history-modal-header').click()
    await expect(page.locator('.history-dialog')).toBeVisible()
  })
})

test.describe('HistoryModal — error states', () => {
  test('shows error when revision list fetch fails', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(() => {
      window.historyHarness.list({ status: 500, body: { error: 'Server error' } })
      window.historyHarness.render()
    })

    await page.waitForSelector('.history-list-error')
    await expect(page.locator('.history-list-error')).toContainText('Failed to load history')
  })

  test('calls onExpired when revision list returns 401', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(() => {
      window.historyHarness.list({ status: 401, body: { error: 'Unauthorized' } })
      window.historyHarness.render()
    })

    await page.waitForFunction(() => window.historyHarness.expiredCalls() > 0)

    const expiredCalls = await page.evaluate(() => window.historyHarness.expiredCalls())
    expect(expiredCalls).toBe(1)
  })
})

test.describe('HistoryModal — API calls', () => {
  test('makes correct requests to Drive Revisions API', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, { fileId: 'my-file-id' })

    const calls = await page.evaluate(() => window.historyHarness.calls())
    expect(calls[0].url).toBe('/api/drive/revisions/my-file-id')
    const urls = calls.map(c => c.url)
    expect(urls).toContain('/api/drive/revisions/my-file-id/rev-3')
  })
})

test.describe('HistoryModal — unsaved entry', () => {
  test('shows "Unsaved" entry when autoSave=false and isDirty=true', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: false,
      isDirty: true,
      text: 'unsaved content edits',
      savedText: 'saved content',
    })

    const unsavedItem = page.locator('.history-revision-item').first()
    await expect(unsavedItem).toContainText('Unsaved')
    await expect(unsavedItem.locator('.unsaved-badge')).toHaveText('Unsaved')
  })

  test('selects "Unsaved" entry by default when autoSave=false and isDirty=true', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: false,
      isDirty: true,
      text: 'unsaved content edits',
      savedText: 'saved content',
    })

    const unsavedItem = page.locator('.history-revision-item').first()
    await expect(unsavedItem).toHaveClass(/selected/)
  })

  test('shows diff between saved and current text when "Unsaved" is selected', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: false,
      isDirty: true,
      text: 'new unsaved content',
      savedText: 'old saved content',
    })

    // Preview should show the current text and diff
    const preview = page.locator('.history-preview-diff')
    await expect(preview).toContainText('new unsaved content')
    // Diff should highlight added/removed words
    await expect(preview.locator('.diff-add-word')).toBeVisible()
  })

  test('restore button is disabled when "Unsaved" entry is selected', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: false,
      isDirty: true,
      text: 'unsaved content edits',
      savedText: 'saved content',
    })

    await expect(page.locator('.btn-restore')).toBeDisabled()
  })

  test('does not show "Unsaved" entry when autoSave=true', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: true,
      isDirty: true,
      text: 'unsaved content edits',
      savedText: 'saved content',
    })

    const firstItem = page.locator('.history-revision-item').first()
    await expect(firstItem).not.toContainText('Unsaved')
    await expect(firstItem).toHaveClass(/selected/)
  })

  test('does not show "Unsaved" entry when isDirty=false', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: false,
      isDirty: false,
      text: 'saved content',
      savedText: 'saved content',
    })

    const firstItem = page.locator('.history-revision-item').first()
    await expect(firstItem).not.toContainText('Unsaved')
    await expect(firstItem).toHaveClass(/selected/)
  })

  test('clicking "Unsaved" entry shows diff', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, {
      autoSave: false,
      isDirty: true,
      text: 'brand new text',
      savedText: 'original saved text',
    })

    // Click on a saved revision
    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')
    await expect(page.locator('.history-revision-item').nth(1)).toHaveClass(/selected/)

    // Click back on "Unsaved"
    await page.locator('.history-revision-item').first().click()
    await expect(page.locator('.history-revision-item').first()).toHaveClass(/selected/)
    const preview = page.locator('.history-preview-diff')
    await expect(preview).toContainText('brand new text')
  })
})
