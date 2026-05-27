import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/entryEditorHarness.html`)
}

async function renderEditor(
  page: import('@playwright/test').Page,
  opts: {
    date?: string
    initialContent?: string
    version?: string | null
    saveReject?: 'conflict' | 'error'
    getContentReject?: 'tokenExpired' | 'error'
    deleteReject?: 'error'
    pendingNavDate?: string | null
    token?: string | null
    autoSave?: boolean
  } = {},
) {
  const date = opts.date ?? '2026-05-01'
  const initialContent = opts.initialContent ?? ''
  const version = opts.version ?? null
  const getContentReject = opts.getContentReject
  const deleteReject = opts.deleteReject
  await page.evaluate(
    ({ date, initialContent, version, saveReject, getContentReject, deleteReject, pendingNavDate, token, autoSave }) => {
      window.editorHarness.render({ date, initialContent, version, saveReject, getContentReject, deleteReject, pendingNavDate, token, autoSave })
    },
    { date, initialContent, version, saveReject: opts.saveReject, getContentReject, deleteReject, pendingNavDate: opts.pendingNavDate, token: opts.token, autoSave: opts.autoSave },
  )
  // Wait for textarea to be visible (loading done)
  await page.waitForSelector('textarea.editor-textarea')
}


test.describe('EntryEditor — date header', () => {
  test('shows an editor placeholder for empty entries', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-02', initialContent: '', version: null })

    await expect(page.locator('textarea.editor-textarea')).toHaveAttribute('placeholder', 'Write your thoughts here...')
  })

  test('shows a load error state without the writing placeholder', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({ date: '2026-05-02', getContentReject: 'error' })
    })

    await expect(page.getByText('Failed to load entry.')).toBeVisible()
    await expect(page.getByText('Check your connection, then try loading this entry again.')).toBeVisible()
    await expect(page.locator('.entry-load-error button')).toHaveText('Refresh entry')
    await expect(page.locator('textarea.editor-textarea')).toHaveCount(0)
    await expect(page.getByText('Write your thoughts here...')).toHaveCount(0)
  })

  test('shows the weekday next to the entry date', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: '' })

    const expectedWeekday = await page.evaluate(() =>
      new Date(2026, 4, 1).toLocaleDateString(undefined, { weekday: 'short' })
    )

    await expect(page.locator('.entry-date-text .entry-date-weekday')).toHaveText(expectedWeekday)
  })

  test('marks today in the entry date header', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: '' })

    await expect(page.locator('.entry-date-text')).toHaveAttribute('data-today', 'true')
  })

  test('shortens the month label on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2024-12-31', initialContent: '' })

    await expect(page.locator('.entry-date-label-full')).toBeHidden()
    await expect(page.locator('.entry-date-label-short')).toBeVisible()
    await expect(page.locator('.entry-date-label-short')).toHaveText('Dec 31, 2024')
  })

  test('keeps the full month label on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2024-09-01', initialContent: '' })

    await expect(page.locator('.entry-date-label-full')).toBeVisible()
    await expect(page.locator('.entry-date-label-full')).toHaveText('September 1, 2024')
    await expect(page.locator('.entry-date-label-short')).toBeHidden()
  })

   test('places mobile save action near the bottom-right thumb zone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-12-31', initialContent: 'saved content', version: '1' })

    const saveButton = page.locator('button.btn-save')
    const moreButton = page.locator('button.btn-more')
    await expect(saveButton).toBeVisible()
    await expect(moreButton).toBeVisible()

    const metrics = await page.evaluate(() => {
      const header = document.querySelector('.editor-header')?.getBoundingClientRect()
      const editor = document.querySelector('.editor')?.getBoundingClientRect()
      const save = document.querySelector('button.btn-save')?.getBoundingClientRect()
      const more = document.querySelector('button.btn-more')?.getBoundingClientRect()
      if (!header || !editor || !save || !more) throw new Error('missing editor layout')

      return {
        editorHeight: editor.height,
        headerLeft: header.left,
        headerRight: header.right,
        headerBottom: header.bottom,
        saveRight: save.right,
        saveBottom: save.bottom,
        saveWidth: save.width,
        saveHeight: save.height,
        moreTop: more.top,
        moreCenterX: more.left + more.width / 2,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })

    expect(metrics.editorHeight).toBeLessThanOrEqual(metrics.viewportHeight)
    expect(metrics.headerLeft).toBeGreaterThanOrEqual(0)
    expect(metrics.headerRight).toBeLessThanOrEqual(metrics.viewportWidth)
    expect(metrics.moreTop).toBeLessThan(metrics.headerBottom)
    expect(metrics.saveRight).toBeLessThanOrEqual(metrics.viewportWidth - 16 + 1)
    expect(metrics.saveBottom).toBeLessThanOrEqual(metrics.viewportHeight - 16 + 1)
    expect(metrics.viewportWidth - metrics.saveRight).toBeLessThanOrEqual(17)
    expect(metrics.viewportHeight - metrics.saveBottom).toBeLessThanOrEqual(17)
    expect(metrics.saveWidth).toBeGreaterThanOrEqual(56)
    expect(metrics.saveHeight).toBeGreaterThanOrEqual(56)
  })

  test('moves mobile discard into the more menu so the date keeps room', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-12-31', initialContent: 'saved content', version: '1', autoSave: false })

    await page.locator('textarea.editor-textarea').fill('saved content with edits')
    await page.waitForSelector('button.btn-discard', { state: 'attached' })

    const metrics = await page.evaluate(() => {
      const header = document.querySelector('.editor-header')?.getBoundingClientRect()
      const actions = document.querySelector('.editor-actions')?.getBoundingClientRect()
      const more = document.querySelector('button.btn-more')?.getBoundingClientRect()
      const save = document.querySelector('button.btn-save')
      const discard = document.querySelector('button.btn-discard')
      if (!header || !actions || !more || !save || !discard) throw new Error('missing editor actions')

      return {
        headerBottom: header.bottom,
        actionsWidth: actions.width,
        moreWidth: more.width,
        savePosition: getComputedStyle(save).position,
        discardDisplay: getComputedStyle(discard).display,
      }
    })

    expect(metrics.savePosition).toBe('fixed')
    expect(metrics.discardDisplay).toBe('none')
    expect(metrics.actionsWidth).toBeLessThanOrEqual(metrics.moreWidth)

    await page.locator('button.btn-more').click()
    await expect(page.locator('.more-menu-discard')).toBeVisible()
    await page.locator('.more-menu-discard').click()
    await expect(page.locator('.discard-undo-toast')).toBeVisible()
  })

  test('moves the mobile save action above the visual viewport keyboard inset', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)

    await page.evaluate(() => {
      const viewport = new EventTarget() as unknown as VisualViewport
      Object.defineProperties(viewport, {
        height: { configurable: true, writable: true, value: window.innerHeight },
        offsetTop: { configurable: true, writable: true, value: 0 },
      })
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: viewport,
      })
    })

    await renderEditor(page, { date: '2026-12-31', initialContent: 'saved content', version: '1' })

    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', {
        configurable: true,
        writable: true,
        value: 420,
      })
      window.visualViewport?.dispatchEvent(new Event('resize'))
    })

    await expect.poll(() =>
      page.locator('button.btn-save').evaluate(button => {
        const save = button.getBoundingClientRect()
        const textarea = document.querySelector('textarea.editor-textarea')
        if (!textarea) throw new Error('missing textarea')
        const textareaStyle = getComputedStyle(textarea)
        const keyboardInset = getComputedStyle(document.documentElement)
          .getPropertyValue('--mobile-keyboard-inset-bottom')
          .trim()

        return {
          keyboardInset,
          distanceFromBottom: Math.round(window.innerHeight - save.bottom),
          textareaPaddingBottom: textareaStyle.paddingBottom,
          textareaScrollPaddingBottom: textareaStyle.scrollPaddingBottom,
        }
      })
    ).toEqual({
      keyboardInset: '280px',
      distanceFromBottom: 296,
      textareaPaddingBottom: '368px',
      textareaScrollPaddingBottom: '368px',
    })
  })

  test('keeps mobile editing scroll inside the textarea', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 520 })
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-12-31',
      initialContent: Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'),
      version: '1',
    })

    const metrics = await page.locator('textarea.editor-textarea').evaluate(textarea => {
      const root = document.documentElement
      return {
        documentScrollable: root.scrollHeight > window.innerHeight || document.body.scrollHeight > window.innerHeight,
        textareaScrollable: textarea.scrollHeight > textarea.clientHeight,
        textareaMinHeight: getComputedStyle(textarea).minHeight,
        textareaOverscroll: getComputedStyle(textarea).overscrollBehaviorY,
      }
    })

    expect(metrics).toEqual({
      documentScrollable: false,
      textareaScrollable: true,
      textareaMinHeight: '0px',
      textareaOverscroll: 'contain',
    })
  })

  test('keeps the mobile header divider stable when more menu appears after loading', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)

    // render() resets getContentBlockedForDate, so block must be set after render.
    // React effects run after the current JS task, so the block is in place before
    // getContent is ever called.
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-12-31',
        initialContent: 'saved content',
        version: '1',
      })
      window.editorHarness.blockGetContent('2026-12-31')
    })
    await page.waitForSelector('.entry-skeleton')

    const loadingHeaderBottom = await page.locator('.editor-header').evaluate(el =>
      el.getBoundingClientRect().bottom
    )

    await page.evaluate(() => window.editorHarness.unblockGetContent())
    await page.waitForSelector('textarea.editor-textarea')
    await expect(page.locator('button.btn-more')).toBeVisible()

    const loadedHeaderBottom = await page.locator('.editor-header').evaluate(el =>
      el.getBoundingClientRect().bottom
    )

    expect(loadedHeaderBottom).toBe(loadingHeaderBottom)
  })
})

test.describe('EntryEditor — auto-save', () => {
  test('auto-save fires after a short idle period and briefly shows saved state', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: '' })

    await page.fill('textarea.editor-textarea', 'auto-save content')
    // Ensure React has registered the auto-save timer after the fill
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))

    // Advance just past the 1500ms auto-save threshold
    await page.clock.fastForward(1501)
    // Give React time to process the callback
    await page.waitForFunction(() => window.editorHarness.saveCalls().length > 0)

    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].content).toBe('auto-save content')
  })

  test('auto-save does not fire while hasConflict is true', async ({ page }) => {
    await page.clock.install()
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'original', version: '1', saveReject: 'conflict' })

    await page.fill('textarea.editor-textarea', 'edited text')

    // Click save button explicitly to get an EntryConflictError shown in the UI
    await page.locator('button.btn-save').click()
    await page.waitForSelector('.conflict-panel')

    await page.evaluate(() => window.editorHarness.clearCalls())

    // Type more content to re-arm the dirty/auto-save timer
    await page.fill('textarea.editor-textarea', 'more edits while conflicted')

    // Advance well past the auto-save threshold
    await page.clock.fastForward(2500)

    // Auto-save should NOT have fired because hasConflict is true
    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toHaveLength(0)
  })
})

test.describe('EntryEditor — keyboard save', () => {
  test('Ctrl+S saves dirty content without clicking the save button', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.fill('textarea.editor-textarea', 'keyboard saved content')
    await page.keyboard.press('Control+S')

    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'keyboard saved content', baseVersion: '1' },
    ])
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

  test('Ctrl+S passes the saved text as baseContent', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.fill('textarea.editor-textarea', 'keyboard saved content')
    await page.keyboard.press('Control+S')

    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCallsWithBaseContent().length)).toBe(1)
    const [call] = await page.evaluate(() => window.editorHarness.saveCallsWithBaseContent())
    expect(call).toMatchObject({
      date: '2026-05-01',
      content: 'keyboard saved content',
      baseVersion: '1',
      baseContent: 'saved content',
    })
  })
})

test.describe('EntryEditor — repeated saves', () => {
  test('uses the saved version as the base for the next save of the same entry', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.fill('textarea.editor-textarea', 'first edit')
    await page.locator('button.btn-save').click()
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')

    await page.fill('textarea.editor-textarea', 'second edit')
    await page.locator('button.btn-save').click()
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')

    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toEqual([
      { date: '2026-05-01', content: 'first edit', baseVersion: '1' },
      { date: '2026-05-01', content: 'second edit', baseVersion: '2' },
    ])

    const fullSaveCalls = await page.evaluate(() => window.editorHarness.saveCallsWithBaseContent())
    expect(fullSaveCalls[0]).toMatchObject({
      content: 'first edit',
      baseVersion: '1',
      baseContent: 'saved content',
    })
    expect(fullSaveCalls[1]).toMatchObject({
      content: 'second edit',
      baseVersion: '2',
      baseContent: 'first edit',
    })
  })
})

test.describe('EntryEditor — conflict resolution', () => {
  test('loads the latest remote content from the conflict panel', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'local base', version: '1', saveReject: 'conflict' })

    await page.fill('textarea.editor-textarea', 'local edits')
    await page.locator('button.btn-save').click()
    await page.waitForSelector('.conflict-panel')

    await page.getByRole('button', { name: 'Load latest' }).click()

    await expect(page.locator('.conflict-panel')).toHaveCount(0)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('remote content')
    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toEqual([
      { date: '2026-05-01', content: 'local edits', baseVersion: '1' },
    ])
  })

  test('keeps local edits when resolving a conflict locally', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'local base', version: '1', saveReject: 'conflict' })

    await page.fill('textarea.editor-textarea', 'local edits')
    await page.locator('button.btn-save').click()
    await page.waitForSelector('.conflict-panel')

    await page.getByRole('button', { name: 'Keep local' }).click()

    await expect(page.locator('.conflict-panel')).toHaveCount(0)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('local edits')
    await expect(page.locator('button.btn-save')).toBeEnabled()
  })

  test('overwrites the remote entry with force and the remote version', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'local base', version: '1', saveReject: 'conflict' })

    await page.fill('textarea.editor-textarea', 'local edits')
    await page.locator('button.btn-save').click()
    await page.waitForSelector('.conflict-panel')

    await page.getByRole('button', { name: 'Overwrite' }).click()
    await expect(page.locator('.conflict-panel')).toHaveCount(0)

    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toEqual([
      { date: '2026-05-01', content: 'local edits', baseVersion: '1' },
      { date: '2026-05-01', content: 'local edits', baseVersion: '99', force: true },
    ])
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

})

test.describe('EntryEditor — delete confirmation', () => {
  test('requires confirm before deleting an existing entry', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.locator('.more-menu')).toBeVisible()
    await page.locator('.more-menu-delete').click()
    await expect(page.getByRole('heading', { name: 'Delete entry?' })).toBeVisible()
    await expect(page.locator('.delete-modal-actions .btn-delete')).toBeDisabled()

    await page.locator('.delete-modal-input').fill('nope')
    await expect(page.locator('.delete-modal-actions .btn-delete')).toBeDisabled()
    expect(await page.evaluate(() => window.editorHarness.deleteCalls())).toEqual([])

    await page.locator('.delete-modal-input').fill('confirm')
    await page.locator('.delete-modal-actions .btn-delete').click()

    await expect(page.locator('.delete-dialog')).toHaveCount(0)
    expect(await page.evaluate(() => window.editorHarness.deleteCalls())).toEqual([
      { date: '2026-05-01' },
    ])
  })

  test('clears editor content after deletion', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await expect(page.locator('textarea.editor-textarea')).toHaveValue('saved content')

    await page.getByRole('button', { name: 'More options' }).click()
    await page.locator('.more-menu-delete').click()
    await page.locator('.delete-modal-input').fill('confirm')
    await page.locator('.delete-modal-actions .btn-delete').click()

    await expect(page.locator('.delete-dialog')).toHaveCount(0)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('')
  })

  test('shows error status and preserves content when deletion fails', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', deleteReject: 'error' })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.locator('.more-menu-delete').click()
    await page.locator('.delete-modal-input').fill('confirm')
    await page.locator('.delete-modal-actions .btn-delete').click()

    await expect(page.locator('.delete-dialog')).toHaveCount(0)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('saved content')
    await expect(page.locator('.editor-status-line')).toHaveText('Delete failed.')
  })
})

test.describe('EntryEditor — unsaved navigation save', () => {
  test('saves and continues pending navigation when banner save succeeds', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      initialContent: 'saved content',
      version: '1',
      pendingNavDate: '2026-05-02',
    })

    await page.fill('textarea.editor-textarea', 'changed content')
    await page.locator('.unsaved-nav-banner').getByRole('button', { name: 'Save' }).click()

    expect(await page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'changed content', baseVersion: '1' },
    ])
    expect(await page.evaluate(() => window.editorHarness.pendingNavigateCalls())).toEqual([
      { date: '2026-05-02' },
    ])
    expect(await page.evaluate(() => window.editorHarness.cancelNavigationCalls())).toEqual([])
    await expect(page.locator('.unsaved-nav-banner')).toHaveCount(0)
  })

  test('cancels pending navigation when banner save fails', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      initialContent: 'saved content',
      version: '1',
      saveReject: 'error',
      pendingNavDate: '2026-05-02',
    })

    await page.fill('textarea.editor-textarea', 'changed content')
    await page.locator('.unsaved-nav-banner').getByRole('button', { name: 'Save' }).click()

    expect(await page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'changed content', baseVersion: '1' },
    ])
    expect(await page.evaluate(() => window.editorHarness.pendingNavigateCalls())).toEqual([])
    expect(await page.evaluate(() => window.editorHarness.cancelNavigationCalls())).toEqual([
      { date: '2026-05-02' },
    ])
    await expect(page.locator('.unsaved-nav-banner')).toHaveCount(0)
  })
})

test.describe('EntryEditor — Open in Drive', () => {
  test('shows Open in Drive in more menu when token and fileId exist', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    // Set token via harness
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        token: 'mock-token',
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.locator('.more-menu')).toBeVisible()
    await expect(page.getByText('Open in Drive')).toBeVisible()
  })

  test('opens Drive URL when clicking Open in Drive', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        token: 'mock-token',
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Open in Drive').click()

    const openCalls = await page.evaluate(() => window.editorHarness.windowOpenCalls())
    expect(openCalls).toHaveLength(1)
    expect(openCalls[0].url).toBe('https://drive.google.com/file/d/file-1/view')
    expect(openCalls[0].target).toBe('_blank')
  })

  test('does not show Open in Drive when token is null', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    // Default harness renders with token: null
    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.locator('.more-menu')).toBeVisible()
    await expect(page.getByText('Open in Drive')).toHaveCount(0)
  })

  test('does not show Open in Drive when fileId is null (no saved entry)', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: '',
        version: null,
        token: 'mock-token',
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    // More options button should exist but Open in Drive should not be in the menu
    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.getByText('Open in Drive')).toHaveCount(0)
    await expect(page.getByText('History')).toHaveCount(0)
  })
})

test.describe('EntryEditor — Share Entry', () => {
  test('Share Entry is disabled when no saved entry exists', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: '', version: null })

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.locator('.more-menu')).toBeVisible()
    await expect(page.getByText('Share Entry')).toHaveClass(/more-menu-item-disabled/)
  })

  test('Share Entry is enabled when a saved entry exists', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.locator('.more-menu')).toBeVisible()
    await expect(page.getByText('Share Entry')).not.toHaveClass(/more-menu-item-disabled/)
  })
})

test.describe('EntryEditor — save progress', () => {
  test('shows inline saving state without overlay on explicit save button click', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        saveDelayMs: 500,
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.fill('textarea.editor-textarea', 'new content')
    await page.locator('button.btn-save').click()

    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saving')
    await expect(page.locator('button.btn-save .btn-text')).toHaveText('Saving…')
    await expect(page.locator('.saving-overlay')).toHaveCount(0)

    await page.clock.fastForward(500)
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

  test('shows inline saving state without overlay on Ctrl+S save', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        saveDelayMs: 3000,
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.fill('textarea.editor-textarea', 'keyboard save')
    await expect(page.locator('button.btn-save')).toBeEnabled()

    await page.keyboard.press('Control+S')

    // Wait for the save button to enter saving state (aria-busy="true")
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saving')
    await expect(page.locator('button.btn-save .btn-saving-spinner')).toBeVisible()
    await expect(page.locator('.saving-overlay')).toHaveCount(0)

    await page.clock.fastForward(3000)
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

  test('does not show saving overlay on auto-save', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        autoSave: true,
        saveDelayMs: 500,
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.fill('textarea.editor-textarea', 'auto-save content')
    // Ensure React registers the timer
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))

    // Advance past auto-save threshold
    await page.clock.fastForward(1501)
    await page.waitForFunction(() => window.editorHarness.saveCalls().length > 0)

    // Overlay should NOT appear during auto-save
    await expect(page.locator('.saving-overlay')).toHaveCount(0)

    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].content).toBe('auto-save content')
  })
})

test.describe('EntryEditor — token expiry', () => {
  test('keeps a failed entry load out of edit mode and prevents saving', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({ getContentReject: 'error', date: '2026-05-01', token: 'mock-token' })
    })
    await expect(page.locator('.entry-load-error')).toBeVisible()

    await expect(page.locator('.entry-load-error')).toContainText('Failed to load entry.')
    await expect(page.locator('textarea.editor-textarea')).toHaveCount(0)
    await expect(page.locator('button.btn-save')).toBeDisabled()

    await page.keyboard.press('Control+S')
    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toHaveLength(0)
  })

  test('does not show failed to load message when getContent throws TokenExpiredError', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({ getContentReject: 'tokenExpired', date: '2026-05-01' })
    })
    await page.waitForSelector('textarea.editor-textarea')

    const statusCount = await page.evaluate(() => document.querySelectorAll('[role="status"]').length)
    expect(statusCount).toBe(0)

    const calls = await page.evaluate(() => window.editorHarness.getContentCalls())
    expect(calls.length).toBe(1)
  })

  test('reloads entry automatically after re-authentication following token expiry', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({ getContentReject: 'tokenExpired', date: '2026-05-01', token: null })
    })
    await page.waitForSelector('textarea.editor-textarea')

    const initialValue = await page.locator('textarea.editor-textarea').inputValue()
    expect(initialValue).toBe('')

    await page.evaluate(() => {
      window.editorHarness.clearCalls()
      window.editorHarness.setRemoteEntry('recovered content', '1')
      window.editorHarness.setToken('new-token')
    })

    await expect.poll(() => page.evaluate(() => window.editorHarness.getContentCalls().length)).toBeGreaterThan(0)

    await expect(page.locator('textarea.editor-textarea')).toHaveValue('recovered content')
  })
})

test.describe('EntryEditor — silent refresh race condition', () => {
  test('does not overwrite user typing with in-flight silent refreshSignal fetch', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('saved content')

    // Block subsequent getContent for this date before triggering a refresh
    await page.evaluate(() => {
      window.editorHarness.blockGetContent('2026-05-01')
    })

    // Increment refreshSignal — loadFreshEntry fires and hangs (blocked)
    await page.evaluate(() => window.editorHarness.setRefreshSignal(1))

    // Wait until the blocked getContent call is in-flight
    await expect.poll(() =>
      page.evaluate(() => window.editorHarness.getContentCalls().length)
    ).toBeGreaterThanOrEqual(2)

    // User types new content while the fetch is still in-flight
    await page.locator('textarea.editor-textarea').pressSequentially('\nuser typed here')

    // Resolve the in-flight fetch — the trailing assertion retries until stable
    await page.evaluate(() => window.editorHarness.unblockGetContent())
    // Typed content must NOT be overwritten by the silent refresh result
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('saved content\nuser typed here')
  })
})

test.describe('EntryEditor — date switch cancellation', () => {
  test('does not overwrite new date content with stale in-flight refreshSignal fetch', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'date A content', version: '1' })
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('date A content')

    // Set up date B content and block any subsequent fetch for date A
    await page.evaluate(() => {
      window.editorHarness.setContentForDate('2026-05-02', 'date B content', '2')
      window.editorHarness.blockGetContent('2026-05-01')
    })

    // Increment refreshSignal — loadFreshEntry fires for date A and hangs (blocked)
    await page.evaluate(() => window.editorHarness.setRefreshSignal(1))

    // Wait until the blocked getContent call for date A is in-flight
    await expect.poll(() =>
      page.evaluate(() => window.editorHarness.getContentCalls().length)
    ).toBeGreaterThanOrEqual(2)

    // Switch to date B while date A's fetch is still in-flight.
    // AnimatePresence keeps date A's exiting motion.div mounted during the
    // transition, so two textareas briefly coexist — wait for the exit
    // animation to settle back to a single textarea before asserting.
    await page.evaluate(() => window.editorHarness.setDate('2026-05-02'))
    await expect.poll(() => page.locator('textarea.editor-textarea').count()).toBe(1)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('date B content')

    // Resolve the stale date A fetch — the trailing assertion retries until stable
    await page.evaluate(() => window.editorHarness.unblockGetContent())

    // Date B content must still be shown — not overwritten by the stale date A result
    await expect.poll(() => page.locator('textarea.editor-textarea').count()).toBe(1)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('date B content')
  })
})

test.describe('EntryEditor — editor meta info', () => {
  test('shows last modified timestamp for saved entries', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('Last modified:')
  })

  test('shows Today\'s entry label for today with no content', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('Today\'s entry')
  })

  test('shows Today\'s entry with last modified for today with content', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: 'saved content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('Today\'s entry · Last modified:')
  })

  test('shows only last modified for past dates with content', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-04-15', initialContent: 'past content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('Last modified:')
    await expect(meta).not.toContainText('Today\'s entry')
  })

  test('hides editor meta when no entry exists for past dates', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-04-15', initialContent: '', version: null })

    await expect(page.locator('.editor-meta')).toBeHidden()
  })

  test('shows Yesterday\'s entry label for yesterday with no content', async ({ page }) => {
    await loadHarness(page)
    const yesterday = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: yesterday, initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('Yesterday\'s entry')
  })

  test('shows Yesterday\'s entry with last modified for yesterday with content', async ({ page }) => {
    await loadHarness(page)
    const yesterday = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: yesterday, initialContent: 'yesterday content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('Yesterday\'s entry · Last modified:')
  })

  test('past dates (not today or yesterday) do not show Yesterday\'s entry label', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-04-14', initialContent: 'old content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).not.toContainText('Yesterday\'s entry')
    await expect(meta).toContainText('Last modified:')
  })

  test('shows future date warning for future dates with no content', async ({ page }) => {
    await loadHarness(page)
    const tomorrow = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: tomorrow, initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('This is a future date')
  })

  test('shows future date warning for future dates with content, not last modified', async ({ page }) => {
    await loadHarness(page)
    const tomorrow = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: tomorrow, initialContent: 'future content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('This is a future date')
    await expect(meta).not.toContainText('Last modified:')
  })
})

test.describe('EntryEditor — dirty dot indicator', () => {
  test('dot is invisible when content is clean', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await expect(page.locator('.dirty-dot')).toHaveCSS('opacity', '0')
  })

  test('dot becomes visible when user types unsaved changes', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.fill('textarea.editor-textarea', 'edited content')

    await expect(page.locator('.dirty-dot')).toHaveCSS('opacity', '1')
  })

  test('dot disappears after saving', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    await page.fill('textarea.editor-textarea', 'edited content')
    await expect(page.locator('.dirty-dot')).toHaveCSS('opacity', '1')

    await page.locator('button.btn-save').click()
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')

    await expect(page.locator('.dirty-dot')).toHaveCSS('opacity', '0')
  })
})
