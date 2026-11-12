import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

const ENTRIES_EMPTY = { files: [] }

function fileMeta(version: string, id = 'file-1') {
  return { id, name: 'diary-2026-05-01.json', version }
}

function datedFileMeta(date: string, version = '1', id = `file-${date}`) {
  return { id, name: `diary-${date}.md`, version }
}

function entryResponse(version: string, content = 'hello', id = 'file-1') {
  return {
    entry: { date: '2026-05-01', content },
    meta: fileMeta(version, id),
  }
}

function datedEntryResponse(date: string, content: string, version = '1') {
  return {
    entry: { date, content },
    meta: datedFileMeta(date, version),
  }
}

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/useDiaryHarness.html`)
  // Clear IndexedDB between tests so cached data from one test never leaks into the next
  await page.evaluate(() => new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('linger_diary_cache')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  }))
}

async function startHarness(page: import('@playwright/test').Page, extraEntries: { files: { id: string; name: string; version: string }[] } = ENTRIES_EMPTY) {
  await page.evaluate((entries) => {
    // Prepend a 404 for the parallel getEntryByDate(today) call that fires
    // alongside loadEntryList — the FIFO mock has no URL matching so the
    // today-404 must sit in front of the list response.
    window.diaryHarness.q({ status: 404, body: { error: 'Not found' } }, { status: 200, body: entries })
    window.diaryHarness.start()
  }, extraEntries)
  await page.waitForSelector('#harness-ready')
}

// Navigate to harness without clearing IDB so tests can inspect cross-session IDB state.
async function reloadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/useDiaryHarness.html`)
}

// Save, read, import/export batching and Changes API cases live in
// tests/unit/useDiary.integration.test.ts (real API client + IDB, mocked HTTP).
// Keep browser persistence, navigation scheduling and lifecycle cases here.

test.describe('useDiary IDB cache — cross-account isolation', () => {
  // Tests use a real page reload to persist IDB between sessions (realistic scenario).

  test('isolates encrypted account data and preserves unattributed legacy queue on account change', async ({ page }) => {
    // Session 1: sign in as user@example.com, save entry → IDB populated
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } })
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'secret diary', null))

    // Verify linger_session_user was set to the default email
    const firstUser = await page.evaluate(() => localStorage.getItem('linger_session_user'))
    expect(firstUser).toBe('user@example.com')

    // The save must not mirror the entry in plaintext localStorage.
    const mirrored = await page.evaluate(() => localStorage.getItem('linger_local_entry_2026-05-01'))
    expect(mirrored).toBeNull()

    // Session 2: reload page (IDB preserved), sign in as a different account.
    // A legacy unscoped queue remains available for explicit recovery but is
    // never replayed against the new account's Drive.
    await reloadHarness(page)
    await page.evaluate(async () => {
      localStorage.setItem('linger_pending_sync_queue', JSON.stringify([
        { id: 'remove-2026-05-01-1', type: 'REMOVE', date: '2026-05-01', timestamp: Date.now() },
      ]))
      window.diaryHarness.setEmail('other@example.com')
      window.diaryHarness.q({ status: 404, body: { error: 'Not found' } }, { status: 200, body: { files: [] } })
      window.diaryHarness.start()
    })
    await page.waitForSelector('#harness-ready')

    // No dates from user@example.com's session are visible to the other account.
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '')
    const stored = await page.evaluate(() => localStorage.getItem('linger_session_user'))
    expect(stored).toBe('other@example.com')
    // The old queue remains, attributed to the old session for recovery.
    expect(await page.evaluate(() => localStorage.getItem('linger_local_entry_2026-05-01'))).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('linger_pending_sync_queue'))).not.toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('linger_legacy_queue_owner'))).toBe('user@example.com')
  })

  test('does not hydrate IDB when the signed-in account email is unknown', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(async () => {
      window.diaryHarness.seedLocalStorageUser('user@example.com')
      await window.diaryHarness.seedIdb([{
        date: '2026-05-01',
        meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' },
        content: { date: '2026-05-01', content: 'cached secret' },
        snippet: 'cached secret',
      }])
      window.diaryHarness.setEmail(null)
      window.diaryHarness.q({ status: 404, body: { error: 'Not found' } }, { status: 200, body: { files: [] } })
      window.diaryHarness.start()
    })
    await page.waitForSelector('#harness-ready')

    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '')
    const stored = await page.evaluate(() => localStorage.getItem('linger_session_user'))
    expect(stored).toBeNull()
  })

  test('preserves IDB when the same account signs back in', async ({ page }) => {
    // Session 1: sign in as user@example.com, save entry → IDB populated
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } })
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'my diary', null))

    // Session 2: same account signs back in
    await reloadHarness(page)
    await page.evaluate(async () => {
      // Same email as default (user@example.com) — IDB should not be cleared
      window.diaryHarness.q({ status: 404, body: { error: 'Not found' } }, { status: 200, body: { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] } })
      window.diaryHarness.start()
    })

    // IDB data should appear before Drive response resolves (0-RTT)
    await expect(page.locator('[data-dates="2026-05-01"]')).toBeVisible({ timeout: 2000 })
    await page.waitForSelector('#harness-ready')
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
  })
})

test.describe('useDiary IDB cache — 0-RTT startup', () => {
  test('shows IDB-cached dates before the Drive list call resolves', async ({ page }) => {
    // Session 1: save entry to populate IDB
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } })
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'hello', null))

    // Session 2: reload with delayed Drive response
    await reloadHarness(page)
    await page.evaluate(() => {
      // Drive response deliberately delayed so IDB hydration is observable first
      window.diaryHarness.q({ status: 404, body: { error: 'Not found' } }, { status: 200, body: { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] }, delayMs: 500 })
      window.diaryHarness.start()
    })

    // Entry from IDB should appear well within the 500ms Drive delay
    await expect(page.locator('[data-dates="2026-05-01"]')).toBeVisible({ timeout: 450 })
    await page.waitForSelector('#harness-ready')
  })
})

test.describe('useDiary prefetch on initial load', () => {
  test('prefetches the 3 most recent entries in the background after sign-in', async ({ page }) => {
    const dates = ['2026-05-03', '2026-05-02', '2026-05-01']
    await loadHarness(page)

    // Queue list + all 3 entry responses so the prefetch can consume them
    await page.evaluate(({ files, entries }) => {
      window.diaryHarness.q(
        { status: 404, body: { error: 'Not found' } },
        { status: 200, body: { files } },
        ...entries.map(entry => ({ status: 200, body: entry })),
      )
      window.diaryHarness.start()
    }, {
      files: dates.map(d => datedFileMeta(d)),
      entries: dates.map(d => datedEntryResponse(d, `content ${d}`)),
    })

    await page.waitForSelector('#harness-ready')
    // 1 today-404 + 1 list call + 3 prefetch content calls
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(5)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Content is now in cache — getContent must not make another network call
    const result = await page.evaluate(() => window.diaryHarness.triggerGetContent('2026-05-03'))
    expect(result?.entry.content).toBe('content 2026-05-03')
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(0)
  })

  test('prefetches at most 3 entries even when more exist', async ({ page }) => {
    const dates = ['2026-05-05', '2026-05-04', '2026-05-03', '2026-05-02', '2026-05-01']
    await loadHarness(page)

    // Queue list + responses for only the 3 most recent entries
    // If a 4th or 5th were attempted, the queue would be exhausted and recorded in calls()
    await page.evaluate(({ files, entries }) => {
      window.diaryHarness.q(
        { status: 404, body: { error: 'Not found' } },
        { status: 200, body: { files } },
        ...entries.map(entry => ({ status: 200, body: entry })),
      )
      window.diaryHarness.start()
    }, {
      files: dates.map(d => datedFileMeta(d)),
      entries: ['2026-05-05', '2026-05-04', '2026-05-03'].map(d => datedEntryResponse(d, `content ${d}`)),
    })

    await page.waitForSelector('#harness-ready')
    // 1 today-404 + 1 list + exactly 3 prefetch calls — 4th and 5th entries must not be attempted
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(5)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    const prefetchUrls = calls.slice(2).map((c: { url: string }) => c.url)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-05'))).toBe(true)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-04'))).toBe(true)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-03'))).toBe(true)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-02'))).toBe(false)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-01'))).toBe(false)
  })
})

test.describe('useDiary adjacent-day prefetch', () => {
  test('prefetches prev and next entries after navigating to a date', async ({ page }) => {
    const dates = ['2026-05-03', '2026-05-02', '2026-05-01']
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Queue responses for both adjacent entries
    await page.evaluate(({ entries }) => {
      window.diaryHarness.q(...entries.map(entry => ({ status: 200, body: entry })))
    }, { entries: ['2026-05-01', '2026-05-03'].map(d => datedEntryResponse(d, `content ${d}`)) })

    await page.evaluate(() => window.diaryHarness.setSelectedDate('2026-05-02'))

    // Both adjacent entries must be fetched within 1s (300ms debounce + buffer)
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 1000 }).toBe(2)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls.some((c: { url: string }) => c.url.includes('2026-05-01'))).toBe(true)
    expect(calls.some((c: { url: string }) => c.url.includes('2026-05-03'))).toBe(true)
  })

  test('prefetches entries two days out in both directions', async ({ page }) => {
    const dates = ['2026-05-01', '2026-05-02', '2026-05-04', '2026-05-05', '2026-05-06']
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // 2026-05-03 has no entry; its ±1/±2 neighbours (05-01, 05-02, 05-04, 05-05) do
    await page.evaluate(({ entries }) => {
      window.diaryHarness.q(...entries.map(entry => ({ status: 200, body: entry })))
    }, { entries: ['2026-05-01', '2026-05-02', '2026-05-04', '2026-05-05'].map(d => datedEntryResponse(d, `content ${d}`)) })

    await page.evaluate(() => window.diaryHarness.setSelectedDate('2026-05-03'))

    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 1000 }).toBe(4)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    for (const d of ['2026-05-01', '2026-05-02', '2026-05-04', '2026-05-05']) {
      expect(calls.some((c: { url: string }) => c.url.includes(d))).toBe(true)
    }
    // 05-06 is three days out — outside the ±2 window
    expect(calls.some((c: { url: string }) => c.url.includes('2026-05-06'))).toBe(false)
  })

  test('skips dates that have no diary entry', async ({ page }) => {
    await loadHarness(page)
    // Only 2026-05-01 exists; adjacent dates (04-30 and 05-02) do not
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.clock.install()
    await page.evaluate(() => window.diaryHarness.setSelectedDate('2026-05-01'))
    // No adjacent entries exist so no fetch should occur even after debounce elapses
    await page.clock.fastForward(400)
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(0)
  })

  test('debounces rapid navigation — only fetches for the final date', async ({ page }) => {
    // Spread the navigation targets far apart so the ±2 prefetch windows of the
    // intermediate dates never overlap the final settled date's window.
    const finalNeighbours = ['2026-05-18', '2026-05-19', '2026-05-21', '2026-05-22']
    const intermediateNeighbours = ['2026-05-01', '2026-05-03', '2026-05-09', '2026-05-11']
    const navDates = ['2026-05-02', '2026-05-10', '2026-05-20']
    const dates = [...finalNeighbours, ...intermediateNeighbours, ...navDates]
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Queue responses only for the neighbours of the final date (2026-05-20)
    await page.evaluate(({ entries }) => {
      window.diaryHarness.q(...entries.map(entry => ({ status: 200, body: entry })))
    }, { entries: finalNeighbours.map(d => datedEntryResponse(d, `content ${d}`)) })

    // Rapid navigation: cycle through dates faster than the 300ms debounce
    await page.evaluate(async () => {
      window.diaryHarness.setSelectedDate('2026-05-02')
      await new Promise(r => setTimeout(r, 50))
      window.diaryHarness.setSelectedDate('2026-05-10')
      await new Promise(r => setTimeout(r, 50))
      window.diaryHarness.setSelectedDate('2026-05-20')
    })

    // Only the ±1/±2 neighbours of the final settled date should be fetched
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 1000 }).toBe(4)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    for (const d of finalNeighbours) {
      expect(calls.some((c: { url: string }) => c.url.includes(d))).toBe(true)
    }
    for (const d of intermediateNeighbours) {
      expect(calls.some((c: { url: string }) => c.url.includes(d))).toBe(false)
    }
  })

  test('skips already-cached entries and avoids redundant network calls', async ({ page }) => {
    const dates = ['2026-05-03', '2026-05-02', '2026-05-01']
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })

    // Pre-load 2026-05-01 into the content cache
    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: datedEntryResponse('2026-05-01', 'cached') })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Queue a response only for the one uncached neighbour (2026-05-03)
    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
    }, { entry: datedEntryResponse('2026-05-03', 'content 2026-05-03') })

    await page.evaluate(() => window.diaryHarness.setSelectedDate('2026-05-02'))

    // Only the uncached neighbour should be fetched
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 1000 }).toBe(1)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls[0].url).toContain('2026-05-03')
  })
})

test.describe('useDiary background prefetch scheduling', () => {
  test('limits background prefetches to two concurrent fetches', async ({ page }) => {
    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })
    // Let the sign-in recent-entry prefetch settle before measuring
    await page.waitForTimeout(100)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ entries, dates }) => {
      window.diaryHarness.q(...entries.map((entry, i) => ({ status: 200, body: entry, delayMs: i < 2 ? 300 : 0 })))
      for (const d of dates) {
        void window.diaryHarness.triggerGetContent(d, { background: true })
      }
    }, { entries: dates.map(d => datedEntryResponse(d, `content ${d}`)), dates })

    // Only the first two start; the rest wait in the queue behind the slow pair
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(2)

    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 2000 }).toBe(4)
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    for (const d of dates) {
      expect(calls.some(c => c.url.includes(d))).toBe(true)
    }
  })

  test('a user-initiated load jumps ahead of queued background prefetches', async ({ page }) => {
    const dates = ['2026-05-01', '2026-05-02', '2026-05-03']
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })
    await page.waitForTimeout(100)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    const result = await page.evaluate(async ({ entries }) => {
      // Two slow background fetches occupy the whole budget; the third date
      // sits in the queue until the user opens it.
      window.diaryHarness.q(
        { status: 200, body: entries[0], delayMs: 500 },
        { status: 200, body: entries[1], delayMs: 500 },
        { status: 200, body: entries[2] },
      )
      void window.diaryHarness.triggerGetContent('2026-05-01', { background: true })
      void window.diaryHarness.triggerGetContent('2026-05-02', { background: true })
      void window.diaryHarness.triggerGetContent('2026-05-03', { background: true })
      const started = Date.now()
      const loaded = await window.diaryHarness.triggerGetContent('2026-05-03')
      return { elapsed: Date.now() - started, content: loaded?.entry.content ?? null }
    }, { entries: dates.map(d => datedEntryResponse(d, `content ${d}`)) })

    // Resolved without waiting for the slow background fetches to finish
    expect(result.content).toBe('content 2026-05-03')
    expect(result.elapsed).toBeLessThan(400)

    // The promoted fetch reused the queued request — no duplicate call for 05-03
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 2000 }).toBe(3)
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls.filter(c => c.url.includes('2026-05-03'))).toHaveLength(1)
  })

  test('background prefetches wait while a user-initiated load is in flight', async ({ page }) => {
    const dates = ['2026-05-01', '2026-05-02']
    await loadHarness(page)
    await startHarness(page, { files: dates.map(d => datedFileMeta(d)) })
    await page.waitForTimeout(100)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ entries }) => {
      window.diaryHarness.q(
        { status: 200, body: entries[0], delayMs: 300 },
        { status: 200, body: entries[1] },
      )
      void window.diaryHarness.triggerGetContent('2026-05-01')
      void window.diaryHarness.triggerGetContent('2026-05-02', { background: true })
    }, { entries: dates.map(d => datedEntryResponse(d, `content ${d}`)) })

    await page.waitForTimeout(100)
    const early = await page.evaluate(() => window.diaryHarness.calls())
    expect(early).toHaveLength(1)
    expect(early[0].url).toContain('2026-05-01')

    // Once the foreground load resolves, the queued prefetch runs
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length, { timeout: 2000 }).toBe(2)
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls[1].url).toContain('2026-05-02')
  })
})

test.describe('useDiary save — entry not found at save time', () => {
  test('save with no cache creates entry via POST with no fileId', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('1') })

    const result = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'new entry', null)
    )

    expect(result).toMatchObject({ ok: true, result: { meta: { version: '1' } } })
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
  })

  test('force save overwrites even when versions differ', async ({ page }) => {
    await loadHarness(page)
    // Start with an entry in the list
    await startHarness(page, { files: [fileMeta('5')] })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // save with force=true, version mismatch should not conflict
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('6') })

    const result = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'forced content', '3', true)
    )

    expect(result).toMatchObject({ ok: true })
    // Wait for any background calls triggered by the save to settle
    await expect.poll(async () => {
      const c = await page.evaluate(() => window.diaryHarness.calls())
      return c.length
    }).toBeGreaterThanOrEqual(1)
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    // Force with existing cache should go straight to save
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/api/drive/entry/')
  })
})

test.describe('useDiary search — local-first', () => {
  test('matches cached content locally even when Drive search returns nothing', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })

    // Load content into the in-memory cache
    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: datedEntryResponse('2026-05-01', '今日は公園まで走った。気持ちよかった。') })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Drive's tokenizer finds nothing, but the local substring pass must hit
    const result = await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { files: [] } })
      return window.diaryHarness.search('走った')
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].date).toBe('2026-05-01')
    expect(result.results[0].snippet).toContain('走った')
    expect(result.totalCount).toBe(1)
    expect(result.unindexedCount).toBe(0)
  })

  test('matches half-width query against full-width cached text via NFKC', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })

    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: datedEntryResponse('2026-05-01', 'ＴＯＥＩＣの勉強をした') })

    const result = await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { files: [] } })
      return window.diaryHarness.search('toeic')
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].date).toBe('2026-05-01')
  })

  test('returns local results when Drive search is unavailable', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01'), datedFileMeta('2026-05-02')] })

    // Only 2026-05-01 has cached content; 2026-05-02 stays uncached
    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: datedEntryResponse('2026-05-01', 'a day with a needle in it') })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    const result = await page.evaluate(() => {
      window.diaryHarness.q({ status: 400, body: { error: 'unavailable' } })
      return window.diaryHarness.search('needle')
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].date).toBe('2026-05-01')
    // The uncached entry could not be searched
    expect(result.unindexedCount).toBe(1)
  })

  test('merges local hits with Drive hits for uncached entries', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01'), datedFileMeta('2026-05-02')] })

    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: datedEntryResponse('2026-05-01', 'local needle entry') })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    const result = await page.evaluate(({ files, entry }) => {
      window.diaryHarness.q(
        { status: 200, body: { files } },
        { status: 200, body: entry },
      )
      return window.diaryHarness.search('needle')
    }, {
      files: [datedFileMeta('2026-05-02')],
      entry: datedEntryResponse('2026-05-02', 'remote needle entry'),
    })

    expect(result.results.map(r => r.date)).toEqual(['2026-05-02', '2026-05-01'])
    expect(result.totalCount).toBe(2)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    // One search call + one content fetch for the uncached hit — the cached
    // entry must not be re-fetched
    expect(calls).toHaveLength(2)
  })
})

test.describe('useDiary offline drafts', () => {
  test('reports a blocked upgrade until an older database connection closes', async ({ page, context }) => {
    await loadHarness(page)
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('linger_diary_cache', 3)
      req.onupgradeneeded = () => {
        const db = req.result
        db.createObjectStore('entries', { keyPath: 'date' })
        db.createObjectStore('drafts', { keyPath: 'date' })
        db.createObjectStore('accountDrafts', { keyPath: 'key' })
      }
      req.onsuccess = () => { (window as unknown as { heldDb: IDBDatabase }).heldDb = req.result; resolve() }
      req.onerror = () => reject(req.error)
    }))
    const other = await context.newPage()
    await other.goto(`${baseUrl}/tests/useDiaryHarness.html`)
    await other.evaluate(async () => {
      const path = '/src/lib/diaryCache.ts'
      const cache = await import(/* @vite-ignore */ path)
      ;(window as unknown as { upgrade: Promise<unknown> }).upgrade = cache.getDiaryDatabase()
    })
    await expect.poll(() => other.evaluate(async () => {
      const path = '/src/lib/diaryCache.ts'
      return (await import(/* @vite-ignore */ path)).getDatabaseNotice()
    })).toBe('blocked')
    await page.evaluate(() => (window as unknown as { heldDb: IDBDatabase }).heldDb.close())
    await other.evaluate(async () => { await (window as unknown as { upgrade: Promise<unknown> }).upgrade })
    await expect.poll(() => other.evaluate(async () => {
      const path = '/src/lib/diaryCache.ts'
      return (await import(/* @vite-ignore */ path)).getDatabaseNotice()
    })).toBeNull()
    await other.close()
  })

  test('stores offline drafts as ciphertext in browser storage', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page)
    await context.setOffline(true)
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'private browser draft sentinel', null))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toMatchObject([{ content: 'private browser draft sentinel' }])
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('linger_diary_cache')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const readStore = (name: string) => new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const records = await Promise.all([readStore('secureRecords'), readStore('accountDrafts')])
      db.close()
      return JSON.stringify(records)
    })
    expect(stored).not.toContain('private browser draft sentinel')
    expect(stored).not.toContain('2026-05-01')
    expect(stored).not.toContain('user@example.com')
  })
  test('persists a draft when a save fails offline and replays it on reconnect', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await context.setOffline(true)
    // Queue left empty — the fetch fails like a dead network
    const failed = await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'offline text', null))
    expect(failed).toMatchObject({ ok: false })

    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toMatchObject([
      { date: '2026-05-01', content: 'offline text', baseVersion: null },
    ])

    // Queue the response before going online — the browser may fire its own
    // 'online' event the moment connectivity returns
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('1') })
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    // Replay saves the draft and removes it
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toEqual([])
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls.at(-1)).toMatchObject({ url: '/api/drive/entry/2026-05-01', method: 'POST' })
  })

  test('marks a draft conflicted when replay hits a conflict and stops retrying it', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page, { files: [fileMeta('1')] })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await context.setOffline(true)
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'offline edit', '1'))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toHaveLength(1)

    await page.evaluate(({ remote }) => {
      window.diaryHarness.q({ status: 409, body: { conflict: remote } })
    }, { remote: entryResponse('2', 'changed on another device') })
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toMatchObject([
      { date: '2026-05-01', content: 'offline edit', conflicted: true },
    ])

    // A later reconnect must not retry the conflicted draft
    await page.evaluate(() => window.diaryHarness.clearCalls())
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(0)
  })

  test('replay skips the date currently open in the editor', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await context.setOffline(true)
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'offline text', null))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toHaveLength(1)

    await page.evaluate(() => window.diaryHarness.setSelectedDate('2026-05-01'))
    // Drop the record of the failed offline save attempt
    await page.evaluate(() => window.diaryHarness.clearCalls())
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(200)

    // The editor owns the open date's draft — no background save attempt
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(0)
    expect(await page.evaluate(() => window.diaryHarness.getDrafts())).toHaveLength(1)
  })

  test('a successful save clears the draft for that date', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page)

    await context.setOffline(true)
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'offline text', null))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toHaveLength(1)

    // Keep the date "open in the editor" so the auto-replay on reconnect skips
    // it and the explicit save below is the one that consumes the response
    await page.evaluate(() => window.diaryHarness.setSelectedDate('2026-05-01'))
    await context.setOffline(false)
    const result = await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
      return window.diaryHarness.save('2026-05-01', 'offline text, finished later', null)
    }, { meta: fileMeta('1') })

    expect(result).toMatchObject({ ok: true })
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toEqual([])
  })

  test('replays drafts from a previous session after the entry list loads', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(async ({ meta }) => {
      // Same account as the previous session — otherwise the cross-account
      // guard rightly wipes the drafts
      window.diaryHarness.seedLocalStorageUser('user@example.com')
      await window.diaryHarness.seedDrafts([{
        date: '2026-05-01',
        content: 'written while offline',
        baseVersion: null,
        baseContent: null,
        savedAt: Date.now(),
      }])
      window.diaryHarness.q(
        { status: 404, body: { error: 'Not found' } },
        { status: 200, body: { files: [] } },
        { status: 200, body: meta },
      )
      window.diaryHarness.start()
    }, { meta: fileMeta('1') })
    await page.waitForSelector('#harness-ready')

    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toEqual([])
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
  })
})

test.describe('useDiary drafts — transient server 5xx (session still alive)', () => {
  test('a save hitting a transient 503 becomes a draft and is replayed, without the session-expired flow', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Initial attempt + the client's 3 backoff retries all hit the 503 the API
    // middleware now returns when Google's token refresh blips — the session is
    // still alive, so this must NOT trigger the session-expired flow
    await page.evaluate(() => {
      window.diaryHarness.q(
        { status: 503, body: { error: 'Token refresh temporarily unavailable' } },
        { status: 503, body: { error: 'Token refresh temporarily unavailable' } },
        { status: 503, body: { error: 'Token refresh temporarily unavailable' } },
        { status: 503, body: { error: 'Token refresh temporarily unavailable' } },
      )
    })
    const failed = await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'kept as draft', null))
    expect(failed).toMatchObject({ ok: false })
    // Failed via the 503 path (initial attempt + 3 backoff retries), not some
    // unrelated harness error masquerading as a save failure
    expect(String((failed as { error: string }).error)).toContain('503')
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(4)

    // No session-expired flow fired, and the edit is kept as a durable draft
    expect(await page.evaluate(() => window.diaryHarness.expiredCalls())).toBe(0)
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toMatchObject([
      { date: '2026-05-01', content: 'kept as draft', baseVersion: null },
    ])

    // Blip passes: the while-online draft poll replays it on its own — no
    // connectivity change is involved, which is the whole point (a server-side
    // token blip never flips navigator.onLine, so replay must not wait for it)
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('1') })

    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts()), { timeout: 20000 }).toEqual([])
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
  })
})

test.describe('useDiary offline drafts — multi-draft replay', () => {
  test('a network failure on one draft does not block others from replaying', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page)

    // Write two drafts while offline
    await context.setOffline(true)
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'draft one', null))
    await page.evaluate(() => window.diaryHarness.save('2026-05-02', 'draft two', null))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toHaveLength(2)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Come back online: first draft save fails (400 — throws without retrying),
    // second succeeds
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q(
        { status: 400, body: { error: 'server error' } },
        { status: 200, body: meta },
      )
    }, { meta: datedFileMeta('2026-05-02', '1') })
    // Queue responses before connectivity returns: the browser may dispatch
    // its own online event immediately when setOffline(false) resolves.
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    // Second draft replayed successfully and removed; first stays (will retry later)
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts()), { timeout: 3000 })
      .toMatchObject([{ date: '2026-05-01', content: 'draft one' }])
  })

  test('a TokenExpiredError during replay aborts the loop and preserves remaining drafts', async ({ page, context }) => {
    await loadHarness(page)
    await startHarness(page)

    await context.setOffline(true)
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'draft one', null))
    await page.evaluate(() => window.diaryHarness.save('2026-05-02', 'draft two', null))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toHaveLength(2)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // 401 on the first draft → replay loop must abort entirely
    await context.setOffline(false)
    await page.evaluate(() => {
      window.diaryHarness.q({ status: 401, body: {} })
      window.dispatchEvent(new Event('online'))
    })

    // Both drafts must still be present (loop aborted after the 401)
    await expect.poll(async () => {
      const calls = await page.evaluate(() => window.diaryHarness.calls())
      return calls.length
    }, { timeout: 2000 }).toBeGreaterThan(0)

    const drafts = await page.evaluate(() => window.diaryHarness.getDrafts())
    expect(drafts).toHaveLength(2)
    const expiredCalls = await page.evaluate(() => window.diaryHarness.expiredCalls())
    expect(expiredCalls).toBeGreaterThan(0)
  })

  test('replay deletes a draft without saving when its content already matches the cached entry', async ({ page }) => {
    await loadHarness(page)
    // Start with 2026-05-01 listed and content pre-loaded
    await startHarness(page, { files: [datedFileMeta('2026-05-01', '1')] })

    // Load content so it's in the in-memory cache
    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: datedEntryResponse('2026-05-01', 'already synced') })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Seed a draft with the exact same content (stale offline draft, now redundant)
    await page.evaluate(async () => {
      await window.diaryHarness.seedDrafts([{
        date: '2026-05-01',
        content: 'already synced',
        baseVersion: '1',
        baseContent: null,
        savedAt: Date.now(),
      }])
      window.diaryHarness.clearExpiredCalls()
    })

    // Trigger replay
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => page.evaluate(() => window.diaryHarness.getDrafts())).toEqual([])

    // No save call should have been made
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(0)
  })
})
