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
    relatedDates?: string[]
    deleteReject?: 'error'
    pendingNavDate?: string | null
    token?: string | null
    autoSave?: boolean
    knownDates?: string[]
    diaryListLoaded?: boolean
    milestones?: import('../src/types').Milestone[]
    enableMilestoneAdd?: boolean
  } = {},
) {
  const date = opts.date ?? '2026-05-01'
  const initialContent = opts.initialContent ?? ''
  const version = opts.version ?? null
  const getContentReject = opts.getContentReject
  const deleteReject = opts.deleteReject
  await page.evaluate(
    ({ date, initialContent, version, saveReject, getContentReject, deleteReject, pendingNavDate, token, autoSave, knownDates, diaryListLoaded, milestones, enableMilestoneAdd, relatedDates }) => {
      window.editorHarness.render({ date, initialContent, version, saveReject, getContentReject, deleteReject, pendingNavDate, token, autoSave, knownDates, diaryListLoaded, milestones, enableMilestoneAdd, relatedDates })
    },
    { date, initialContent, version, saveReject: opts.saveReject, getContentReject, deleteReject, pendingNavDate: opts.pendingNavDate, token: opts.token, autoSave: opts.autoSave, knownDates: opts.knownDates, diaryListLoaded: opts.diaryListLoaded, milestones: opts.milestones, enableMilestoneAdd: opts.enableMilestoneAdd, relatedDates: opts.relatedDates },
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

  test('shows a softer placeholder for a new empty entry', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-02',
      initialContent: '',
      version: null,
      knownDates: ['2026-05-01'],
      diaryListLoaded: true,
    })

    await expect(page.locator('textarea.editor-textarea')).toHaveAttribute('placeholder', 'What would you like to remember about this day?')
  })

  test('hides the character count until a new empty entry has text', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-02',
      initialContent: '',
      version: null,
      knownDates: ['2026-05-01'],
      diaryListLoaded: true,
    })

    await expect(page.locator('.editor-charcount')).toHaveCount(0)

    await page.locator('textarea.editor-textarea').fill('Started writing')

    await expect(page.locator('.editor-charcount')).toHaveText('15 chars')
  })

  test('skips the loading skeleton when the fresh entry list says the date has no entry', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-02',
        getContentDelayMs: 1000,
        knownDates: ['2026-05-01'],
        diaryListLoaded: true,
      })
    })

    await expect(page.locator('.entry-skeleton')).toHaveCount(0)
    await expect(page.locator('textarea.editor-textarea')).toBeVisible()
  })

  test('keeps the loading skeleton when list absence is not from a fresh entry list', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-02',
        getContentDelayMs: 1000,
        knownDates: ['2026-05-01'],
        diaryListLoaded: false,
      })
    })

    await expect(page.locator('.entry-skeleton')).toBeVisible({ timeout: 200 })
    await expect(page.locator('textarea.editor-textarea')).toHaveCount(0)
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

  test('splits the date into year and month-day segments on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2024-12-31', initialContent: '' })

    const weekday = await page.evaluate(() =>
      new Date(2024, 11, 31).toLocaleDateString(undefined, { weekday: 'short' })
    )

    // monthday segment contains only the date — no weekday bleed
    await expect(page.locator('.entry-date-text .entry-date-monthday')).toHaveText('December 31')
    // weekday travels with the year segment for year-last locales
    await expect(page.locator('.entry-date-text .entry-date-year')).toContainText('2024')
    await expect(page.locator('.entry-date-text .entry-date-year')).toContainText(weekday)
    // Full date must be visible (not clipped) even at the narrowest width.
    await expect(page.locator('.entry-date-text .entry-date-monthday')).toBeVisible()
    await expect(page.locator('.entry-date-text .entry-date-year')).toBeVisible()
  })

  test('keeps the full month name on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2024-09-01', initialContent: '' })

    const weekday = await page.evaluate(() =>
      new Date(2024, 8, 1).toLocaleDateString(undefined, { weekday: 'short' })
    )

    await expect(page.locator('.entry-date-text .entry-date-monthday')).toHaveText('September 1')
    await expect(page.locator('.entry-date-text .entry-date-year')).toContainText('2024')
    await expect(page.locator('.entry-date-text .entry-date-year')).toContainText(weekday)
  })

   test('places mobile save action near the bottom-right thumb zone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-12-31', initialContent: 'saved content', version: '1' })

    const saveButton = page.locator('button.btn-save')
    const moreButton = page.locator('button.btn-more')
    // Make the entry dirty so the save FAB becomes visible; wait for scale-in to finish
    await page.locator('textarea').fill('modified content')
    await expect(saveButton).toBeVisible()
    await expect(moreButton).toBeVisible()
    await expect.poll(() => saveButton.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(56)

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
    await page.locator('textarea.editor-textarea').fill('modified content')

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

  test('keeps day navigation tap feedback scale-only on coarse pointers', async ({ page }) => {
    await page.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window)
      window.matchMedia = (query: string) => {
        if (query.includes('pointer: coarse')) {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          } as MediaQueryList
        }
        return nativeMatchMedia(query)
      }
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    const nextButton = page.getByRole('button', { name: 'Next day' })
    const box = await nextButton.boundingBox()
    expect(box).not.toBeNull()

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(50)

    const inlineStyle = await nextButton.evaluate(el => el.getAttribute('style') ?? '')
    await page.mouse.up()

    expect(inlineStyle).not.toContain('background')
    expect(inlineStyle).not.toContain('color')
  })
})

test.describe('EntryEditor — auto-save', () => {
  test('auto-save fires after a short idle period and briefly shows saved state', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: '' })

    await page.fill('textarea.editor-textarea', 'auto-save content')
    await expect(page.locator('button.btn-save')).toBeDisabled()
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
    await renderEditor(page, { date: '2026-05-01', initialContent: 'original', version: '1', saveReject: 'conflict', autoSave: false })

    await page.fill('textarea.editor-textarea', 'edited text')

    // Click save button explicitly to get an EntryConflictError shown in the UI
    await page.locator('button.btn-save').click()
    await page.waitForSelector('.conflict-panel')
    await page.evaluate(() => window.editorHarness.setAutoSave(true))

    await page.evaluate(() => window.editorHarness.clearCalls())

    // Type more content to re-arm the dirty/auto-save timer
    await page.fill('textarea.editor-textarea', 'more edits while conflicted')

    // Advance well past the auto-save threshold
    await page.clock.fastForward(2500)

    // Auto-save should NOT have fired because hasConflict is true
    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls).toHaveLength(0)
  })

  test('Save button and Ctrl+S stay inactive while auto-save is enabled', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: true })

    await page.fill('textarea.editor-textarea', 'dirty auto-save content')
    await expect(page.locator('button.btn-save')).toBeDisabled()
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Auto-save')
    await expect(page.locator('button.btn-save .btn-text')).toHaveText('Auto-save')
    await expect(page.locator('button.btn-save')).not.toHaveAttribute('title', /.+/)

    await page.keyboard.press('Control+S')
    expect(await page.evaluate(() => window.editorHarness.saveCalls())).toHaveLength(0)

    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
    await page.clock.fastForward(1501)
    await page.waitForFunction(() => window.editorHarness.saveCalls().length > 0)

    expect(await page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'dirty auto-save content', baseVersion: '1' },
    ])
  })

  test('auto-save uses the same inline saving state without enabling the manual action', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: true })

    await page.evaluate(() => window.editorHarness.blockSave())
    await page.fill('textarea.editor-textarea', 'dirty auto-save content')
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
    await page.clock.fastForward(1501)

    const save = page.locator('button.btn-save')
    await expect(save).toBeDisabled()
    await expect(save).toHaveAttribute('aria-busy', 'true')
    await expect(save).toHaveAttribute('aria-label', 'Saving')
    await expect(save.locator('.btn-text')).toHaveText('Saving…')
    await expect(page.locator('.save-progress-bar')).toHaveCount(0)

    await page.evaluate(() => window.editorHarness.unblockSave())
    await expect(save).toHaveAttribute('aria-label', 'Saved')
  })
})

test.describe('EntryEditor — offline', () => {
  test('shows the offline badge while disconnected', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'original', version: '1' })

    await expect(page.locator('.editor-meta-offline')).toHaveCount(0)
    await page.evaluate(() => window.editorHarness.setOnline(false))
    await expect(page.locator('.editor-meta-offline')).toBeVisible()
    await page.evaluate(() => window.editorHarness.setOnline(true))
    await expect(page.locator('.editor-meta-offline')).toHaveCount(0)
  })

  test('queues a save made while offline and retries it on reconnect', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'original', version: '1', autoSave: false })

    await page.evaluate(() => window.editorHarness.setOnline(false))
    await page.fill('textarea.editor-textarea', 'written while offline')
    await page.locator('button.btn-save').click()

    // No hard failure — a pending message, edits stay unsaved, no save reached the backend
    await expect(page.getByText('Offline — your changes will be saved when you reconnect.')).toBeVisible()
    await expect(page.locator('.editor-meta-unsaved')).toBeVisible()
    expect(await page.evaluate(() => window.editorHarness.saveCalls())).toHaveLength(0)

    // Reconnect → the queued edits are saved automatically
    await page.evaluate(() => window.editorHarness.setOnline(true))

    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'written while offline', baseVersion: '1' },
    ])
    await expect(page.locator('.editor-meta-offline')).toHaveCount(0)
    await expect(page.locator('button.btn-save')).toBeDisabled()
  })

  test('auto-save while offline is retried once on reconnect', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'original', version: '1', autoSave: true })

    await page.evaluate(() => window.editorHarness.setOnline(false))
    await page.fill('textarea.editor-textarea', 'auto written offline')

    // Auto-save fires while offline and fails silently (no save recorded)
    await page.waitForTimeout(1700)
    expect(await page.evaluate(() => window.editorHarness.saveCalls())).toHaveLength(0)

    await page.evaluate(() => window.editorHarness.setOnline(true))
    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'auto written offline', baseVersion: '1' },
    ])
  })
})

test.describe('EntryEditor — keyboard save', () => {
  test('Ctrl+S saves dirty content without clicking the save button', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    await page.fill('textarea.editor-textarea', 'keyboard saved content')
    await page.keyboard.press('Control+S')

    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'keyboard saved content', baseVersion: '1' },
    ])
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

  test('Ctrl+S passes the saved text as baseContent', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

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

test.describe('EntryEditor — toolbar focus retention', () => {
  test('clicking save keeps the textarea focused so the mobile keyboard stays open', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    await page.fill('textarea.editor-textarea', 'edited content')
    await expect(page.locator('textarea.editor-textarea')).toBeFocused()

    await page.locator('button.btn-save').click()

    // The save still runs...
    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCalls())).toEqual([
      { date: '2026-05-01', content: 'edited content', baseVersion: '1' },
    ])
    // ...but onPointerDown preventDefault keeps focus on the textarea, so the
    // virtual keyboard never collapses and the toolbar doesn't shift.
    await expect(page.locator('textarea.editor-textarea')).toBeFocused()
  })

  test('tapping a day-nav button does not steal focus from the textarea', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    await page.locator('textarea.editor-textarea').focus()
    await expect(page.locator('textarea.editor-textarea')).toBeFocused()

    await page.locator('button.btn-day-nav').first().click()

    await expect(page.locator('textarea.editor-textarea')).toBeFocused()
  })
})

test.describe('EntryEditor — repeated saves', () => {
  test('uses the saved version as the base for the next save of the same entry', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

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
    await renderEditor(page, { date: '2026-05-01', initialContent: 'local base', version: '1', saveReject: 'conflict', autoSave: false })

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
    await renderEditor(page, { date: '2026-05-01', initialContent: 'local base', version: '1', saveReject: 'conflict', autoSave: false })

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
    await renderEditor(page, { date: '2026-05-01', initialContent: 'local base', version: '1', saveReject: 'conflict', autoSave: false })

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
      autoSave: false,
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
      autoSave: false,
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

  test('auto-save mode persists and continues navigation without showing the banner', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      initialContent: 'saved content',
      version: '1',
      autoSave: true,
    })

    // Make the entry dirty, then request a day switch via the harness.
    await page.fill('textarea.editor-textarea', 'changed content')
    await page.evaluate(() => window.editorHarness.setPendingNavDate('2026-05-02'))

    // The banner never appears; the edits are saved and navigation proceeds.
    await expect(page.locator('.unsaved-nav-banner')).toHaveCount(0)
    await page.waitForFunction(() => window.editorHarness.pendingNavigateCalls().length > 0)

    expect(await page.evaluate(() => window.editorHarness.pendingNavigateCalls())).toEqual([
      { date: '2026-05-02' },
    ])
    const saveCalls = await page.evaluate(() => window.editorHarness.saveCalls())
    expect(saveCalls.at(-1)).toMatchObject({ date: '2026-05-01', content: 'changed content', baseVersion: '1' })
    expect(await page.evaluate(() => window.editorHarness.cancelNavigationCalls())).toEqual([])
  })

  test('auto-save mode falls back to the banner when the save fails', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      initialContent: 'saved content',
      version: '1',
      saveReject: 'conflict',
      autoSave: true,
    })

    await page.fill('textarea.editor-textarea', 'changed content')
    await page.evaluate(() => window.editorHarness.setPendingNavDate('2026-05-02'))

    // Auto-save hit a conflict, so navigation is held and the banner appears.
    await expect(page.locator('.unsaved-nav-banner')).toBeVisible()
    expect(await page.evaluate(() => window.editorHarness.pendingNavigateCalls())).toEqual([])
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
  test('more menu keeps the compact popup style', async ({ page }) => {
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
    const menu = page.locator('.more-menu')
    await expect(menu).toBeVisible()

    const metrics = await menu.evaluate(el => {
      const styles = getComputedStyle(el)
      return {
        width: el.getBoundingClientRect().width,
        background: styles.backgroundColor,
        borderWidth: styles.borderTopWidth,
        borderRadius: styles.borderTopLeftRadius,
        padding: styles.paddingTop,
        shadow: styles.boxShadow,
        itemCount: el.querySelectorAll('.more-menu-item').length,
      }
    })

    expect(metrics.width).toBeGreaterThanOrEqual(120)
    expect(metrics.width).toBeLessThan(180)
    expect(metrics.background).toBe('rgb(247, 246, 252)')
    expect(parseFloat(metrics.borderWidth)).toBeGreaterThanOrEqual(1)
    expect(metrics.borderRadius).toBe('8px')
    expect(metrics.padding).toBe('4px')
    expect(metrics.shadow).not.toBe('none')
    expect(metrics.itemCount).toBe(4)
  })

  test('more button stays visually quiet while menu is open', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      initialContent: 'saved content',
      version: '1',
      token: 'mock-token',
    })

    const moreButton = page.locator('button.btn-more')
    await moreButton.click()
    await expect(page.locator('.more-menu')).toBeVisible()

    const styles = await moreButton.evaluate(el => {
      const buttonStyles = getComputedStyle(el)
      const icon = el.querySelector('.btn-icon')
      return {
        borderColor: buttonStyles.borderTopColor,
        boxShadow: buttonStyles.boxShadow,
        color: buttonStyles.color,
        iconColor: icon ? getComputedStyle(icon).color : '',
      }
    })

    expect(styles.borderColor).toBe('rgba(0, 0, 0, 0)')
    expect(styles.boxShadow).toBe('none')
    expect(styles.iconColor).toBe(styles.color)
  })

  test('delete menu icon keeps the danger color while hovered and pressed', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      initialContent: 'saved content',
      version: '1',
      token: 'mock-token',
    })

    await page.getByRole('button', { name: 'More options' }).click()
    const deleteItem = page.locator('.more-menu-delete')
    await deleteItem.hover()

    const hovered = await deleteItem.evaluate(el => {
      const probe = document.createElement('span')
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger')
      document.body.appendChild(probe)
      const danger = getComputedStyle(probe).color
      probe.remove()
      const icon = el.querySelector('.btn-icon')

      return {
        danger,
        item: getComputedStyle(el).color,
        icon: icon ? getComputedStyle(icon).color : '',
      }
    })
    expect(hovered.item).toBe(hovered.danger)
    expect(hovered.icon).toBe(hovered.danger)

    await page.mouse.down()
    const pressed = await deleteItem.evaluate(el => {
      const icon = el.querySelector('.btn-icon')
      return {
        item: getComputedStyle(el).color,
        icon: icon ? getComputedStyle(icon).color : '',
      }
    })
    await page.mouse.up()

    expect(pressed.item).toBe(hovered.danger)
    expect(pressed.icon).toBe(hovered.danger)
  })

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
  test('shows inline saving state and progress bar on explicit save button click', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        autoSave: false,
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.fill('textarea.editor-textarea', 'new content')
    await page.evaluate(() => window.editorHarness.blockSave())
    await page.locator('button.btn-save').click()

    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saving')
    await expect(page.locator('button.btn-save .btn-text')).toHaveText('Saving…')
    await expect(page.locator('.save-progress-bar')).toHaveCount(1)
    await expect(page.locator('.saving-overlay')).toHaveCount(0)

    await page.evaluate(() => window.editorHarness.unblockSave())
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

  test('shows inline saving state and progress bar on Ctrl+S save', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.editorHarness.render({
        date: '2026-05-01',
        initialContent: 'saved content',
        version: '1',
        autoSave: false,
      })
    })
    await page.waitForSelector('textarea.editor-textarea')

    await page.fill('textarea.editor-textarea', 'keyboard save')
    await expect(page.locator('button.btn-save')).toBeEnabled()

    await page.evaluate(() => window.editorHarness.blockSave())
    await page.keyboard.press('Control+S')

    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saving')
    await expect(page.locator('button.btn-save .btn-saving-spinner')).toBeVisible()
    await expect(page.locator('.save-progress-bar')).toHaveCount(1)
    await expect(page.locator('.saving-overlay')).toHaveCount(0)

    await page.evaluate(() => window.editorHarness.unblockSave())
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')
  })

  test('does not show saving progress or overlay on auto-save', async ({ page }) => {
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

    // Visual save progress should stay quiet during auto-save.
    await expect(page.locator('.save-progress-bar')).toHaveCount(0)
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
    // Click to focus and move cursor to end before typing
    await page.locator('textarea.editor-textarea').click()
    await page.keyboard.press('Control+End')
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
  test('shows enabled milestones regardless of distance from the selected date', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-01-01',
      milestones: [
        { id: 'birthday', label: 'Birthday', date: '2000-05-10' },
        { id: 'hidden', label: 'Hidden', date: '2000-05-11', showBadge: false },
      ],
    })

    const milestone = page.locator('.editor-meta-milestone')
    await expect(milestone).toHaveCount(1)
    await expect(milestone).toHaveText('🎀 Birthday 9367d ago')
  })

  test('opens the milestone entry by click or keyboard', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-01-01',
      milestones: [
        { id: 'birthday', label: 'Birthday', date: '2020-05-10' },
      ],
    })

    const anniversary = page.getByRole('button', { name: 'Open Birthday entry for 2020-05-10' })
    await anniversary.click()
    await anniversary.focus()
    await anniversary.press('Enter')

    expect(await page.evaluate(() => window.editorHarness.selectedDateCalls())).toEqual([
      '2020-05-10',
      '2020-05-10',
    ])
  })

  test('styles matching milestone badges as contained and other dates as outlined', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2020-05-10',
      milestones: [
        { id: 'birthday', label: 'Birthday', date: '2020-05-10' },
        { id: 'graduation', label: 'Graduation', date: '2020-05-11' },
      ],
    })

    const contained = page.getByRole('button', { name: 'Open Birthday entry for 2020-05-10' })
    const outlined = page.getByRole('button', { name: 'Open Graduation entry for 2020-05-11' })
    const containedStyles = await contained.evaluate(element => {
      const computed = getComputedStyle(element)
      return {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        borderWidth: computed.borderWidth,
        color: computed.color,
      }
    })
    const outlinedStyles = await outlined.evaluate(element => {
      const computed = getComputedStyle(element)
      return {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        borderWidth: computed.borderWidth,
        boxShadow: computed.boxShadow,
        cursor: computed.cursor,
      }
    })
    expect(containedStyles).toEqual({
      backgroundColor: 'rgb(92, 95, 168)',
      borderColor: 'rgb(92, 95, 168)',
      borderWidth: '1px',
      color: 'rgb(255, 255, 255)',
    })
    expect(outlinedStyles).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderColor: 'rgb(92, 95, 168)',
      borderWidth: '1px',
      boxShadow: 'none',
      cursor: 'pointer',
    })

    await outlined.hover()
    await expect.poll(() => outlined.evaluate(element => getComputedStyle(element).transform))
      .not.toBe('none')
  })

  test('shows at most five milestone badges at once', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-01-01',
      milestones: [
        { id: 'one', label: 'One', date: '2025-12-31' },
        { id: 'two', label: 'Two', date: '2026-01-01' },
        { id: 'three', label: 'Three', date: '2026-01-02' },
        { id: 'four', label: 'Four', date: '2026-02-01' },
        { id: 'five', label: 'Five', date: '2026-03-01' },
        { id: 'six', label: 'Six', date: '2026-04-01' },
      ],
    })

    await expect(page.locator('.editor-meta-milestone')).toHaveCount(5)
    await expect(page.locator('.editor-meta')).not.toContainText('Six')
  })

  test('shows days ago for saved past entries', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('days ago')
  })

  test('shows Today label for today with no content', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('Today')
  })

  test('shows Today label for today with content', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: 'saved content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('Today')
  })

  test('renders the Today label as an accent pill', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: '', version: null })

    const pill = page.locator('.editor-meta-today')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveText('Today')
    // Past/future labels stay plain text, so the pill must not appear for them
    await renderEditor(page, { date: '2026-04-15', initialContent: '', version: null })
    await expect(page.locator('.editor-meta-today')).toHaveCount(0)
  })

  test('shows days ago for past dates with content', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-04-15', initialContent: 'past content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('days ago')
    await expect(meta).not.toContainText('Today')
  })

  test('shows days ago for past dates with no content', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-04-15', initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('days ago')
  })

  test('shows 1 day ago for yesterday with no content', async ({ page }) => {
    await loadHarness(page)
    const yesterday = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: yesterday, initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('1 day ago')
  })

  test('shows 1 day ago for yesterday with content', async ({ page }) => {
    await loadHarness(page)
    const yesterday = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: yesterday, initialContent: 'yesterday content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('1 day ago')
  })

  test('past dates beyond yesterday show days ago, not 1 day ago', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-04-14', initialContent: 'old content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).not.toHaveText('1 day ago')
    await expect(meta).toContainText('days ago')
  })

  test('shows days from now for future dates with no content', async ({ page }) => {
    await loadHarness(page)
    const tomorrow = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: tomorrow, initialContent: '', version: null })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('1 day from now')
  })

  test('shows days from now for future dates with content', async ({ page }) => {
    await loadHarness(page)
    const tomorrow = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: tomorrow, initialContent: 'future content', version: '1' })

    const meta = page.locator('.editor-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toHaveText('1 day from now')
  })
})

test.describe('EntryEditor — unsaved indicator', () => {
  test('unsaved label is absent when content is clean', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    await expect(page.locator('.editor-meta-unsaved')).toHaveCount(0)
  })

  test('unsaved label appears when user types unsaved changes', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    await page.fill('textarea.editor-textarea', 'edited content')

    await expect(page.locator('.editor-meta-unsaved')).toBeVisible()
    await expect(page.locator('.editor-meta-unsaved')).toHaveText('Unsaved')
  })

  test('unsaved label stays visible during auto-save without adding a text separator', async ({ page }) => {
    await page.clock.install({ time: 0 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: true })

    await page.fill('textarea.editor-textarea', 'edited content')

    const unsaved = page.locator('.editor-meta-unsaved')
    await expect(unsaved).toBeVisible()
    await expect(unsaved).toHaveText('Unsaved')

    const marginLeft = await unsaved.evaluate(el => getComputedStyle(el).marginLeft)
    expect(parseFloat(marginLeft)).toBeGreaterThan(0)
    expect(await unsaved.textContent()).not.toContain('·')
  })

  test('unsaved label disappears after saving', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    await page.fill('textarea.editor-textarea', 'edited content')
    await expect(page.locator('.editor-meta-unsaved')).toBeVisible()

    await page.locator('button.btn-save').click()
    await expect(page.locator('button.btn-save')).toHaveAttribute('aria-label', 'Saved')

    await expect(page.locator('.editor-meta-unsaved')).toHaveCount(0)
  })
})

const TRANSPARENT = 'rgba(0, 0, 0, 0)'

test.describe('EntryEditor — save button appearance', () => {
  test('save button is a quiet ghost when idle, solid accent when dirty (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    const save = page.locator('button.btn-save')
    // Idle: nothing to save → transparent fill (ghost)
    await expect(save).toBeDisabled()
    expect(await save.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(TRANSPARENT)

    // Dirty: solid accent fill (poll past the background-color transition)
    await page.fill('textarea.editor-textarea', 'edited content')
    await expect(save).toBeEnabled()
    await expect.poll(() => save.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(TRANSPARENT)
  })

  test('saved save button does not run an extra flash animation', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    const save = page.locator('button.btn-save')
    await page.fill('textarea.editor-textarea', 'edited content')
    await save.click()
    await expect(save).toHaveClass(/btn-saved/)

    expect(await save.evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  })

  test('mobile save FAB is hidden when not dirty and visible when dirty', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'saved content', version: '1', autoSave: false })

    const save = page.locator('button.btn-save')
    await expect(save).toBeDisabled()
    await expect(save).toHaveCSS('opacity', '0')

    await page.locator('textarea').fill('modified content')
    await expect(save).toBeEnabled()
    await expect(save).toHaveCSS('opacity', '1')
  })
})

test.describe('EntryEditor — Today FAB', () => {
  test('btn-today-fab is not in the DOM when viewing today', async ({ page }) => {
    await loadHarness(page)
    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await renderEditor(page, { date: today, initialContent: '' })

    await expect(page.locator('button.btn-today-fab')).toHaveCount(0)
  })

  test('btn-today-fab is hidden on desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'content', version: '1' })

    const fab = page.locator('button.btn-today-fab')
    await expect(fab).toHaveCount(1)
    expect(await fab.evaluate(el => getComputedStyle(el).display)).toBe('none')
  })

  test('btn-today-fab is visible on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'content', version: '1' })

    await expect(page.locator('button.btn-today-fab')).toBeVisible()
  })

  test('btn-today-fab click triggers onGoToToday', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', initialContent: 'content', version: '1' })

    await page.locator('button.btn-today-fab').click()
    const count = await page.evaluate(() => window.editorHarness.goToTodayCount())
    expect(count).toBe(1)
  })
})

type TestDraft = {
  date: string
  content: string
  baseVersion: string | null
  baseContent: string | null
  savedAt: number
  conflicted?: boolean
}

async function clearDraftDb(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('linger_diary_cache')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  }))
}

async function seedDraft(page: import('@playwright/test').Page, draft: TestDraft) {
  await page.evaluate((d) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('linger_diary_cache', 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'date' })
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'date' })
    }
    req.onsuccess = () => {
      const db = req.result
      const put = db.transaction('drafts', 'readwrite').objectStore('drafts').put(d)
      put.onsuccess = () => { db.close(); resolve() }
      put.onerror = () => { db.close(); reject(put.error) }
    }
    req.onerror = () => reject(req.error)
  }), draft)
}

async function getDrafts(page: import('@playwright/test').Page): Promise<TestDraft[]> {
  return page.evaluate(() => new Promise<TestDraft[]>((resolve, reject) => {
    const req = indexedDB.open('linger_diary_cache', 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'date' })
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'date' })
    }
    req.onsuccess = () => {
      const db = req.result
      const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
      all.onsuccess = () => { db.close(); resolve(all.result as TestDraft[]) }
      all.onerror = () => { db.close(); reject(all.error) }
    }
    req.onerror = () => reject(req.error)
  }))
}

test.describe('EntryEditor — offline drafts', () => {
  test('restores a persisted draft as unsaved changes and saves with the draft base', async ({ page }) => {
    await loadHarness(page)
    await clearDraftDb(page)
    await seedDraft(page, {
      date: '2026-05-01',
      content: 'draft text written offline',
      baseVersion: '1',
      baseContent: 'saved text',
      savedAt: Date.now(),
    })
    await renderEditor(page, { initialContent: 'saved text', version: '1', token: 'tok', autoSave: false })

    await expect(page.locator('textarea.editor-textarea')).toHaveValue('draft text written offline')
    await expect(page.locator('.editor-meta-unsaved')).toBeVisible()
    await expect(page.locator('.editor-status-line')).toHaveText('Restored unsaved changes from this device.')

    await page.locator('button.btn-save').click()
    await expect.poll(() => page.evaluate(() => window.editorHarness.saveCallsWithBaseContent())).toMatchObject([
      { date: '2026-05-01', content: 'draft text written offline', baseVersion: '1', baseContent: 'saved text' },
    ])
  })

  test('drops a stale draft that matches the loaded content', async ({ page }) => {
    await loadHarness(page)
    await clearDraftDb(page)
    await seedDraft(page, {
      date: '2026-05-01',
      content: 'same text',
      baseVersion: '1',
      baseContent: 'older text',
      savedAt: Date.now(),
    })
    await renderEditor(page, { initialContent: 'same text', version: '2', token: 'tok', autoSave: false })

    await expect(page.locator('textarea.editor-textarea')).toHaveValue('same text')
    await expect(page.locator('.editor-meta-unsaved')).toHaveCount(0)
    await expect.poll(() => getDrafts(page)).toEqual([])
  })

  test('discarding restored draft edits removes the draft and reloads the saved entry', async ({ page }) => {
    await loadHarness(page)
    await clearDraftDb(page)
    await seedDraft(page, {
      date: '2026-05-01',
      content: 'draft to discard',
      baseVersion: '1',
      baseContent: 'saved text',
      savedAt: Date.now(),
    })
    await renderEditor(page, { initialContent: 'saved text', version: '1', token: 'tok', autoSave: false })
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('draft to discard')

    await page.locator('button.btn-more').click()
    await page.locator('.more-menu-discard').click()

    await expect(page.locator('textarea.editor-textarea')).toHaveValue('saved text')
    await expect.poll(() => getDrafts(page)).toEqual([])
  })
})

test.describe('EntryEditor — swipe day navigation', () => {
  // Browsers without touch support (desktop WebKit) can't construct real
  // TouchEvents, so fabricate plain events carrying the touches/changedTouches
  // shape useSwipeNav reads. Gesture thresholds themselves are covered by the
  // useSwipeNav unit tests; these verify the wiring to onPrevDay/onNextDay.
  async function dispatchTouchSequence(
    page: import('@playwright/test').Page,
    steps: { type: string; x: number; y: number }[],
  ) {
    await page.evaluate((steps) => {
      const el = document.querySelector('textarea.editor-textarea')!
      for (const s of steps) {
        const e = new Event(s.type, { bubbles: true })
        const point = { clientX: s.x, clientY: s.y }
        Object.defineProperty(e, 'touches', { value: s.type === 'touchend' ? [] : [point] })
        Object.defineProperty(e, 'changedTouches', { value: [point] })
        el.dispatchEvent(e)
      }
    }, steps)
  }

  test('swiping left on the entry body navigates to the next day', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { initialContent: 'hello', version: '1' })

    await dispatchTouchSequence(page, [
      { type: 'touchstart', x: 320, y: 240 },
      { type: 'touchmove', x: 260, y: 240 },
      { type: 'touchend', x: 200, y: 240 },
    ])

    await expect.poll(() => page.evaluate(() => window.editorHarness.nextDayCount())).toBe(1)
    expect(await page.evaluate(() => window.editorHarness.prevDayCount())).toBe(0)
  })

  test('swiping right on the entry body navigates to the previous day', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { initialContent: 'hello', version: '1' })

    await dispatchTouchSequence(page, [
      { type: 'touchstart', x: 200, y: 240 },
      { type: 'touchmove', x: 260, y: 240 },
      { type: 'touchend', x: 320, y: 240 },
    ])

    await expect.poll(() => page.evaluate(() => window.editorHarness.prevDayCount())).toBe(1)
    expect(await page.evaluate(() => window.editorHarness.nextDayCount())).toBe(0)
  })

  test('a vertical scroll gesture does not navigate', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { initialContent: 'hello', version: '1' })

    await dispatchTouchSequence(page, [
      { type: 'touchstart', x: 300, y: 150 },
      { type: 'touchmove', x: 305, y: 250 },
      { type: 'touchend', x: 220, y: 400 },
    ])

    expect(await page.evaluate(() => window.editorHarness.prevDayCount())).toBe(0)
    expect(await page.evaluate(() => window.editorHarness.nextDayCount())).toBe(0)
  })

  test('a swipe while text is selected does not navigate', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { initialContent: 'hello world', version: '1' })

    await page.evaluate(() => {
      const ta = document.querySelector('textarea.editor-textarea') as HTMLTextAreaElement
      ta.setSelectionRange(0, 5)
    })
    await dispatchTouchSequence(page, [
      { type: 'touchstart', x: 320, y: 240 },
      { type: 'touchmove', x: 260, y: 240 },
      { type: 'touchend', x: 200, y: 240 },
    ])

    expect(await page.evaluate(() => window.editorHarness.nextDayCount())).toBe(0)
  })
})

test.describe('EntryEditor — Add as Milestone', () => {
  test('shows "Add as Milestone" in more menu when onMilestoneAdd is provided', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.getByText('Add as Milestone')).toBeVisible()
  })

  test('hides "Add as Milestone" when onMilestoneAdd is not provided', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01' })

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.getByText('Add as Milestone')).toHaveCount(0)
  })

  test('clicking "Add as Milestone" opens a modal dialog with the entry date pre-filled', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-06-14', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()

    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('.more-menu')).toHaveCount(0)
    // Date picker button has accessible name "Date" (from label) but shows the pre-filled date as text
    await expect(dialog.getByRole('button', { name: 'Date' })).toContainText('2026-06-14')
    await expect(dialog.getByLabel('Name (e.g. Birthday)')).toBeVisible()
  })

  test('shows yearly/one-time toggle in the inline form', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()

    await expect(page.getByRole('button', { name: 'Yearly' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'One-time' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Yearly' })).toHaveClass(/active/)
  })

  test('keeps dialog visible and prevents save when label is empty', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(dialog).toBeVisible()
    // Click Add without filling label — native or custom validation keeps dialog open
    await dialog.getByRole('button', { name: 'Add' }).click()

    await expect(dialog).toBeVisible()
    const calls = await page.evaluate(() => window.editorHarness.milestoneAddCalls())
    expect(calls).toHaveLength(0)
  })

  test('calls onMilestoneAdd with label, date, and recurring=true by default', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-06-14', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await dialog.getByLabel('Name (e.g. Birthday)').fill('Wedding Anniversary')
    await dialog.getByRole('button', { name: 'Add' }).click()

    const calls = await page.evaluate(() => window.editorHarness.milestoneAddCalls())
    expect(calls).toHaveLength(1)
    expect(calls[0].label).toBe('Wedding Anniversary')
    expect(calls[0].date).toBe('2026-06-14')
    expect(calls[0].recurring).toBe(true)
  })

  test('calls onMilestoneAdd with recurring=false when One-time is selected', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await dialog.getByLabel('Name (e.g. Birthday)').fill('Concert')
    await dialog.getByRole('button', { name: 'One-time' }).click()
    await dialog.getByRole('button', { name: 'Add' }).click()

    const calls = await page.evaluate(() => window.editorHarness.milestoneAddCalls())
    expect(calls[0].recurring).toBe(false)
  })

  test('closes modal after successful add', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await dialog.getByLabel('Name (e.g. Birthday)').fill('Birthday')
    await dialog.getByRole('button', { name: 'Add' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.locator('.more-menu')).toHaveCount(0)
  })

  test('cancel button closes the modal', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, { date: '2026-05-01', enableMilestoneAdd: true })

    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByText('Add as Milestone').click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('.more-menu')).toHaveCount(0)

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.locator('.more-menu')).toHaveCount(0)
  })

  test('"Add as Milestone" is disabled when at 50-milestone limit', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      enableMilestoneAdd: true,
      milestones: Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`,
        label: `Milestone ${i}`,
        date: `2020-${String((i % 12) + 1).padStart(2, '0')}-01`,
      })),
    })

    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.getByText('Add as Milestone')).toBeDisabled()
  })
})

test.describe('EntryEditor — related entries', () => {
  test('shows related entry pills when relatedDates is provided', async ({ page }) => {
    await loadHarness(page)
    await renderEditor(page, {
      date: '2026-05-01',
      relatedDates: ['2026-01-10', '2025-12-20'],
    })

    await expect(page.locator('.editor-related')).toBeVisible()
    await expect(page.locator('.editor-related-item')).toHaveCount(2)
  })
})
