import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('linger_language', 'en')
  })
})

test('valid session skips login screen and shows diary directly', async ({ page }) => {
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

test('keeps editor header typography stable between skeleton and loaded states', async ({ page }) => {
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
  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: false } })
  })

  await page.goto(baseUrl)

  await expect(page.locator('.login-screen')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
  await expect(page.locator('.editor-textarea')).toHaveCount(0)
})


test('loads the selected entry and shows its content', async ({ page }) => {
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
