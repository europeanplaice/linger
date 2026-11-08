import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('linger_language', 'en')
  })
})

test('valid session skips login screen and shows diary directly', async ({ page }) => {
  await installMockOAuthCredentials(page)
  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: true } })
  })
  await page.route('/api/drive/entries', async route => {
    await route.fulfill({ json: { files: [] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await route.fulfill({ status: 404, body: '' })
  })

  await page.goto(baseUrl)

  await expect(page.locator('.editor-textarea')).toBeVisible()
  await expect(page.locator('.login-screen')).toHaveCount(0)
})

test('reload requires fresh auth while preserving the cached draft', async ({ page }) => {
  const email = 'cached-reader@example.com'
  const content = 'Previously saved diary content'
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 2 })
  await page.goto(`${baseUrl}/tests/useDiaryHarness.html`)
  const date = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  await page.evaluate(async ({ email, content, date }) => {
    localStorage.setItem('linger_session_user', email)
    await window.diaryHarness.seedIdb([{ date, meta: { id: 'cached-file', name: `diary-${date}.txt`, version: '1' }, content: { date, content } }])
    await window.diaryHarness.seedDrafts([{ date, content: 'Unsaved offline draft', baseVersion: '1', baseContent: content, savedAt: Date.now() }])
  }, { email, content, date })

  let releaseDrive!: () => void
  const gate = new Promise<void>(resolve => { releaseDrive = resolve })
  await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true, email, googleSub: 'cached-reader' } }))
  await page.route('/api/drive/entries', async route => {
    await gate
    await route.fulfill({ json: { files: [{ id: 'cached-file', name: `diary-${date}.txt`, version: '1' }] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await gate
    await route.fulfill({ json: { entry: { date, content }, meta: { id: 'cached-file', name: `diary-${date}.txt`, version: '1' } } })
  })
  // The first mount has in-memory credentials. Reload creates a fresh module
  // instance with no credentials, so it must request sign-in while retaining
  // the cached diary row in IndexedDB.
  try {
    await page.goto(baseUrl)
    await expect(page.locator('textarea.editor-textarea')).toHaveValue('Unsaved offline draft')
    await page.reload()
    await expect(page.locator('.login-screen')).toBeVisible()
    const cachedData = await page.evaluate(async ({ date, email }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('linger_diary_cache', 3)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = db.transaction(['entries', 'accountDrafts'], 'readonly')
      const [entry, draft] = await Promise.all(['entries', 'accountDrafts'].map(store => new Promise<any>((resolve, reject) => {
        const request = transaction.objectStore(store).get(store === 'entries' ? date : `${email}\u0000${date}`)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })))
      db.close()
      return { entry, draft }
    }, { date, email })
    expect(cachedData.entry?.content?.content).toBe(content)
    expect(cachedData.draft?.content).toBe('Unsaved offline draft')
  } finally {
    releaseDrive()
  }
})

test('keeps editor header typography stable between skeleton and loaded states', async ({ page }) => {
  await installMockOAuthCredentials(page)
  await page.setViewportSize({ width: 320, height: 700 })

  let releaseEntry!: () => void
  const entryGate = new Promise<void>(resolve => { releaseEntry = resolve })

  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: true } })
  })
  await page.route('/api/drive/entries', async route => {
    await route.fulfill({ json: { files: [] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await entryGate
    await route.fulfill({ status: 404, body: '' })
  })

  await page.goto(baseUrl)

  // Entry is loading — skeleton shown in the real editor (no separate restoring screen)
  await expect(page.locator('.entry-skeleton')).toBeVisible()

  // Sidebar is off-screen on mobile (not forced open during loading)
  await expect.poll(async () => page.locator('.sidebar').evaluate(el => {
    const rect = el.getBoundingClientRect()
    return Math.round(rect.right)
  })).toBeLessThanOrEqual(0)
  await page.evaluate(() => document.fonts.ready)

  const loadingMetrics = await page.locator('.editor-header h2').evaluate(el => {
    const styles = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      height: rect.height,
      lineHeight: styles.lineHeight,
    }
  })

  releaseEntry()
  await expect(page.locator('textarea.editor-textarea')).toBeVisible()
  // Wait for the skeleton exit animation (180ms) to fully complete before measuring.
  await expect(page.locator('.entry-skeleton')).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

  const loadedMetrics = await page.locator('.editor-header h2').evaluate(el => {
    const styles = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      height: rect.height,
      lineHeight: styles.lineHeight,
    }
  })

  expect(loadedMetrics.fontFamily).toBe(loadingMetrics.fontFamily)
  expect(loadedMetrics.fontSize).toBe(loadingMetrics.fontSize)
  expect(loadedMetrics.lineHeight).toBe(loadingMetrics.lineHeight)
  expect(Math.abs(loadedMetrics.height - loadingMetrics.height)).toBeLessThan(1)
})

test('no session shows login screen with sign-in button', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: false } })
  })

  await page.goto(baseUrl)

  await expect(page.locator('.login-screen')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
  await expect(page.locator('.editor-textarea')).toHaveCount(0)
})

test('popup sign-in accepts exact-origin credentials in memory and a reload requires sign-in again', async ({ page }) => {
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })
  const sessionHeaders: Record<string, string>[] = []
  await page.route('/auth/session', async route => {
    const headers = await route.request().allHeaders()
    sessionHeaders.push(headers)
    await route.fulfill({ json: { signedIn: Boolean(headers.authorization && headers['x-linger-google-id-token']), email: 'popup@example.com', googleSub: 'popup-sub' } })
  })
  await page.context().route('**/auth/login**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><script>
      window.opener.postMessage({ type: 'linger-oauth-complete', credential: {
        accessToken: 'popup-access-secret', idToken: 'popup-id-secret', expiresAt: Date.now() + 3600000
      } }, window.location.origin);
      window.close();
    </script>`,
  }))
  await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))
  await page.route('/api/drive/entry/**', route => route.fulfill({ status: 404, body: '' }))
  await page.route('/api/drive/milestones', route => route.fulfill({ json: [] }))

  await page.goto(baseUrl)
  await expect(page.locator('.login-screen')).toBeVisible()
  await page.getByRole('button', { name: 'Sign in with Google' }).click()
  await expect(page.locator('.editor-textarea')).toBeVisible()
  expect(sessionHeaders.at(-1)?.authorization).toBe('Bearer popup-access-secret')
  expect(sessionHeaders.at(-1)?.['x-linger-google-id-token']).toBe('popup-id-secret')
  const browserStorage = await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage }))
  expect(browserStorage).not.toContain('popup-access-secret')
  expect(browserStorage).not.toContain('popup-id-secret')

  await page.reload()
  await expect(page.locator('.login-screen')).toBeVisible()
  expect(sessionHeaders).toHaveLength(1)
})


test('loads the selected entry and shows its content', async ({ page }) => {
  await installMockOAuthCredentials(page)
  await page.addInitScript(() => {
    const RealDate = Date
    const fixedNow = new RealDate('2026-05-01T12:00:00+09:00').getTime()
    class MockDate extends RealDate {
      constructor(...args: []) {
        if (args.length === 0) {
          super(fixedNow)
        } else {
          super(...args)
        }
      }
      static now() { return fixedNow }
    }
    Object.defineProperty(window, 'Date', { configurable: true, value: MockDate })
  })

  const selectedDate = '2026-05-01'
  const olderDate = '2026-04-30'
  const requestLog: string[] = []
  let releaseSelectedEntry!: () => void
  const selectedEntryGate = new Promise<void>(resolve => { releaseSelectedEntry = resolve })

  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: true } })
  })

  await page.route('/api/drive/entries', async route => {
    await route.fulfill({
      json: {
        files: [
          { id: 'file-selected', name: `diary-${selectedDate}.json`, version: '11' },
          { id: 'file-older', name: `diary-${olderDate}.json`, version: '10' },
        ],
      },
    })
  })

  await page.route('/api/drive/entry/**', async route => {
    const date = new URL(route.request().url()).pathname.split('/').pop()
    if (date === selectedDate) {
      requestLog.push('selected')
      await selectedEntryGate
      await route.fulfill({
        json: {
          entry: { date: selectedDate, content: 'selected entry content', updated_at: '2026-05-01T00:00:00.000Z' },
          meta: { id: 'file-selected', name: `diary-${selectedDate}.json`, version: '11' },
        },
      })
      return
    }

    if (date === olderDate) {
      requestLog.push('older')
      await route.fulfill({
        json: {
          entry: { date: olderDate, content: 'older entry content', updated_at: '2026-04-30T00:00:00.000Z' },
          meta: { id: 'file-older', name: `diary-${olderDate}.json`, version: '10' },
        },
      })
      return
    }

    await route.fulfill({ status: 404, body: '' })
  })

  await page.goto(baseUrl)

  await expect.poll(() => requestLog).toContain('selected')

  releaseSelectedEntry()
  await expect(page.locator('.editor-textarea')).toHaveValue('selected entry content')
})
