import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

const REV_LIST = {
  revisions: [
    { id: 'rev-3', modifiedTime: new Date(Date.now() - 60_000).toISOString() },
    { id: 'rev-2', modifiedTime: new Date(Date.now() - 3_600_000).toISOString() },
    { id: 'rev-1', modifiedTime: new Date(Date.now() - 86_400_000).toISOString() },
  ],
}

const CONTENT_V3 = { date: '2026-05-01', content: 'latest version text', updated_at: new Date().toISOString() }
const CONTENT_V2 = { date: '2026-05-01', content: 'older version text', updated_at: new Date().toISOString() }

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/historyModalHarness.html`)
}

async function renderModal(
  page: import('@playwright/test').Page,
  opts: { date?: string; fileId?: string; baseVersion?: string | null; text?: string; savedText?: string; isDirty?: boolean; autoSave?: boolean } = {},
) {
  // Queue: list revisions, then rev-3 content, then rev-2 content (for diff)
  await page.evaluate(({ revList, contentV3, contentV2, opts }) => {
    window.historyHarness.q(
      { status: 200, body: revList },
      { status: 200, body: contentV3 },
      { status: 200, body: contentV2 },
    )
    window.historyHarness.render(opts)
  }, { revList: REV_LIST, contentV3: CONTENT_V3, contentV2: CONTENT_V2, opts })
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
      window.historyHarness.q(
        { status: 200, body: { revisions: [
          { id: 'rev-2', modifiedTime: new Date(todayNoon - 60_000).toISOString() },
          { id: 'rev-1', modifiedTime: new Date(todayNoon - 3_600_000).toISOString() },
        ] } },
        { status: 200, body: content },
        { status: 200, body: content },
      )
      window.historyHarness.render()
    }, { content: CONTENT_V3 })
    await page.waitForSelector('.history-preview-diff')

    const firstTime = await page.locator('.history-revision-item').first().locator('.history-revision-time').textContent()
    expect(firstTime).toMatch(/Today/)
  })

  test('shows skeleton while list is loading', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(({ revList, content }) => {
      window.historyHarness.q(
        { status: 200, body: revList, delayMs: 300 },
        { status: 200, body: content },
        { status: 200, body: content },
      )
      window.historyHarness.render()
    }, { revList: REV_LIST, content: CONTENT_V3 })

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

  test('clicking a different revision loads its content', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page)

    // When clicking rev-2, need rev-2 content and rev-1 (previous) content
    await page.evaluate(({ contentV2, contentV1 }) => {
      window.historyHarness.q(
        { status: 200, body: contentV2 },
        { status: 200, body: contentV1 },
      )
    }, { contentV2: CONTENT_V2, contentV1: CONTENT_V3 })

    await page.locator('.history-revision-item').nth(1).click()

    await expect(page.locator('.history-revision-item').nth(1)).toHaveClass(/selected/)
    await expect(page.locator('.history-preview-diff')).toContainText(CONTENT_V2.content)
  })

  test('shows preview skeleton while content is loading', async ({ page }) => {
    await loadHarness(page)

    // List response is fast, preview response is delayed
    await page.evaluate(({ revList, contentV3, contentV2 }) => {
      window.historyHarness.q(
        { status: 200, body: revList },
        { status: 200, body: contentV3, delayMs: 300 },
        { status: 200, body: contentV2 },
      )
      window.historyHarness.render()
    }, { revList: REV_LIST, contentV3: CONTENT_V3, contentV2: CONTENT_V2 })

    await page.waitForSelector('.history-revision-item')
    await expect(page.locator('.history-preview-skeleton')).toBeVisible()
    await page.waitForSelector('.history-preview-diff')
    await expect(page.locator('.history-preview-skeleton')).toHaveCount(0)
  })

  test('starts current and previous revision fetches together for diff preview', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(({ revList, contentV3, contentV2 }) => {
      window.historyHarness.q(
        { status: 200, body: revList },
        { status: 200, body: contentV3, delayMs: 200 },
        { status: 200, body: contentV2, delayMs: 200 },
      )
      window.historyHarness.render()
    }, { revList: REV_LIST, contentV3: CONTENT_V3, contentV2: CONTENT_V2 })

    await expect.poll(async () => (await page.evaluate(() => window.historyHarness.calls())).length).toBe(3)
    await page.waitForSelector('.history-preview-diff')
  })

  test('shows error when preview fetch fails', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(({ revList }) => {
      window.historyHarness.q(
        { status: 200, body: revList },
        { status: 500, body: { error: 'Server error' } },
      )
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
      window.historyHarness.q(
        { status: 200, body: { revisions: [{ id: 'rev-1', modifiedTime: new Date().toISOString() }] } },
        { status: 200, body: { date: '2026-05-01', content, updated_at: new Date().toISOString() } },
      )
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

    // When clicking rev-2, need rev-2 content and rev-1 (previous) content
    await page.evaluate(({ contentV2, contentV1 }) => {
      window.historyHarness.q(
        { status: 200, body: contentV2 },
        { status: 200, body: contentV1 },
      )
    }, { contentV2: CONTENT_V2, contentV1: CONTENT_V3 })

    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')

    await expect(page.locator('.btn-restore')).toBeEnabled()
  })

  test('restore calls onSave with the selected content and closes modal', async ({ page }) => {
    await loadHarness(page)
    await renderModal(page, { baseVersion: '7', savedText: 'current saved content' })

    // Clicking rev-2: need rev-2 content and rev-1 (previous) content
    await page.evaluate(({ contentV2, contentV1 }) => {
      window.historyHarness.q(
        { status: 200, body: contentV2 },
        { status: 200, body: contentV1 },
      )
    }, { contentV2: CONTENT_V2, contentV1: CONTENT_V3 })

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

    // Clicking rev-2: need rev-2 content and rev-1 (previous) content
    await page.evaluate(({ contentV2, contentV1 }) => {
      window.historyHarness.q(
        { status: 200, body: contentV2 },
        { status: 200, body: contentV1 },
      )
    }, { contentV2: CONTENT_V2, contentV1: CONTENT_V3 })

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

    // Clicking rev-2: need rev-2 content and rev-1 (previous) content
    await page.evaluate(({ contentV2, contentV1 }) => {
      window.historyHarness.q(
        { status: 200, body: contentV2 },
        { status: 200, body: contentV1 },
      )
    }, { contentV2: CONTENT_V2, contentV1: CONTENT_V3 })

    await page.locator('.history-revision-item').nth(1).click()
    await page.waitForSelector('.history-preview-diff')

    await page.evaluate(() => window.historyHarness.setSaveReject('error'))
    await page.locator('.btn-restore').click()

    await expect(page.locator('.history-restore-error')).toBeVisible()
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
      window.historyHarness.q({ status: 500, body: { error: 'Server error' } })
      window.historyHarness.render()
    })

    await page.waitForSelector('.history-list-error')
    await expect(page.locator('.history-list-error')).toContainText('Failed to load history')
  })

  test('calls onExpired when revision list returns 401', async ({ page }) => {
    await loadHarness(page)

    await page.evaluate(() => {
      window.historyHarness.q({ status: 401, body: { error: 'Unauthorized' } })
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
    await page.waitForFunction(() => window.historyHarness.calls().length >= 2)

    const calls = await page.evaluate(() => window.historyHarness.calls())
    expect(calls[0].url).toBe('/api/drive/revisions/my-file-id')
    expect(calls[1].url).toBe('/api/drive/revisions/my-file-id/rev-3')
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
