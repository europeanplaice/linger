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
    entry: { date: '2026-05-01', content, updated_at: '2026-05-01T00:00:00.000Z' },
    meta: fileMeta(version, id),
  }
}

function datedEntryResponse(date: string, content: string, version = '1') {
  return {
    entry: { date, content, updated_at: '2026-05-01T00:00:00.000Z' },
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
    window.diaryHarness.q({ status: 200, body: entries })
    window.diaryHarness.start()
  }, extraEntries)
  await page.waitForSelector('#harness-ready')
}

// Navigate to harness without clearing IDB so tests can inspect cross-session IDB state.
async function reloadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/useDiaryHarness.html`)
}

test.describe('useDiary save — conflict detection', () => {
  test('first save of a new entry posts once and lets the API check existence', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('1') })

    const result = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'hello', null)
    )

    expect(result).toMatchObject({ ok: true, result: { meta: { version: '1' } } })

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls[0].url).toBe('/api/drive/entry/2026-05-01')
    expect(calls[0].method).toBe('POST')
    expect(calls).toHaveLength(1)
  })

  test('second save posts once with the cached file and base version', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    // First save — seeds the cache with file-1 at version 1
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('1') })

    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'hello', null))
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ saveMeta }) => {
      window.diaryHarness.q({ status: 200, body: saveMeta })
    }, { saveMeta: fileMeta('2') })

    const second = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'hello world', '1')
    )

    expect(second).toMatchObject({ ok: true, result: { meta: { version: '2' } } })

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls[0].url).toBe('/api/drive/entry/2026-05-01')
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ fileId: 'file-1', baseVersion: '1' })
    expect(calls).toHaveLength(1)
  })

  test('no false conflict when cached version matches baseVersion', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    // First save → version 5 in cache
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('5') })

    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'draft', null))
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ saveMeta }) => {
      window.diaryHarness.q({ status: 200, body: saveMeta })
    }, { saveMeta: fileMeta('6') })

    const second = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'draft with more', '5')
    )

    expect(second).toMatchObject({ ok: true, result: { meta: { version: '6' } } })
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
  })

  test('allows a save when only the remote version advanced but the base content is unchanged', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('2') })

    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'draft', null))
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ saveMeta }) => {
      window.diaryHarness.q({ status: 200, body: saveMeta })
    }, { saveMeta: fileMeta('4') })

    const second = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'draft with more', '2', false, 'draft')
    )

    expect(second).toMatchObject({ ok: true, result: { meta: { version: '4' } } })
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ baseVersion: '2', baseContent: 'draft' })
  })

  test('remote conflict is detected even when the local cache version still matches baseVersion', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [fileMeta('1')] })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ remote }) => {
      window.diaryHarness.q({ status: 409, body: { conflict: remote } })
    }, { remote: entryResponse('2', 'remote changed text') })

    const result = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'my local edits', '1')
    )

    expect(result).toMatchObject({ ok: false, error: 'conflict' })
    expect(result).toMatchObject({ conflict: { meta: { version: '2' } } })

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
  })

  test('real conflict is detected when save is called with a stale baseVersion', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    // First save → seeds cache with file-1 at version 2
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('2') })
    await page.evaluate(() => window.diaryHarness.save('2026-05-01', 'my text', null))

    // Second save with old baseVersion 2; server reports the remote is now at version 3
    await page.evaluate(({ entry3 }) => {
      window.diaryHarness.q({ status: 409, body: { conflict: entry3 } })
    }, { entry3: entryResponse('3', 'remote text') })

    const result = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'my local edits', '2')
    )

    expect(result).toMatchObject({ ok: false, error: 'conflict' })
    expect(result).toMatchObject({ conflict: { meta: { version: '3' } } })
  })
})

test.describe('useDiary getContent', () => {
  test('can bypass cached content when a fresh entry is requested', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [fileMeta('1')] })

    await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    }, { entry: entryResponse('1', 'cached text') })

    await page.evaluate(() => window.diaryHarness.clearCalls())

    const refreshed = await page.evaluate(({ entry }) => {
      window.diaryHarness.q({ status: 200, body: entry })
      return window.diaryHarness.triggerGetContent('2026-05-01', { forceNetwork: true })
    }, { entry: entryResponse('2', 'fresh text') })

    expect(refreshed?.entry.content).toBe('fresh text')
    expect(refreshed?.meta.version).toBe('2')

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/drive/entry/2026-05-01?fileId=file-1')

    await page.evaluate(() => window.diaryHarness.clearCalls())
    const cached = await page.evaluate(() => window.diaryHarness.triggerGetContent('2026-05-01'))
    expect(cached?.entry.content).toBe('fresh text')
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(0)
  })

  test('calls onExpired and re-throws TokenExpiredError when /api returns 401', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 401, body: {} })
    })

    const result = await page.evaluate(async () => {
      try {
        await window.diaryHarness.triggerGetContent('2026-05-01')
        return { threw: false, message: null }
      } catch (e) {
        return { threw: true, message: e instanceof Error ? e.message : String(e) }
      }
    })

    expect(result.threw).toBe(true)
    expect(result.message).toBe('Session expired')

    const expired = await page.evaluate(() => window.diaryHarness.expiredCalls())
    expect(expired).toBe(1)
  })
})

test.describe('useDiary save — session expiry', () => {
  test('retryPendingSave preserves baseContent after re-authentication', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [fileMeta('1')] })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 401, body: {} })
    })

    const failed = await page.evaluate(() =>
      window.diaryHarness.save('2026-05-01', 'pending content', '1', false, 'saved base')
    )
    expect(failed).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.diaryHarness.expiredCalls())).toBe(1)

    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
    }, { meta: fileMeta('2') })

    const retried = await page.evaluate(() => window.diaryHarness.retryPendingSave())

    expect(retried).toMatchObject({ ok: true, result: { meta: { version: '2' } } })
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1].body ?? '{}')).toMatchObject({
      fileId: 'file-1',
      baseVersion: '1',
      baseContent: 'saved base',
    })
  })
})

test.describe('useDiary Drive read batching', () => {
  test('search loads uncached matching entries with bounded parallel requests', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05']
    await page.evaluate(({ files, entries }) => {
      window.diaryHarness.q(
        { status: 200, body: { files } },
        ...entries.map(entry => ({ status: 200, body: entry, delayMs: 200 })),
      )
      ;(window as any).__searchResult = null
      void window.diaryHarness.search('needle').then(result => {
        ;(window as any).__searchResult = result
      })
    }, {
      files: dates.map(date => datedFileMeta(date)),
      entries: dates.map(date => datedEntryResponse(date, `text with needle ${date}`)),
    })

    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(6)
    await expect.poll(async () => page.evaluate(() => (window as any).__searchResult?.results.length ?? 0)).toBe(5)
  })

  test('exportAll reads entries with bounded parallel requests and preserves sorted output', async ({ page }) => {
    await loadHarness(page)
    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06']
    await startHarness(page, { files: dates.map(date => datedFileMeta(date)) })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(({ entries }) => {
      window.diaryHarness.q(
        ...entries.map(entry => ({ status: 200, body: entry, delayMs: 200 })),
      )
      ;(window as any).__exportResult = null
      void window.diaryHarness.exportAll('txt').then(result => {
        ;(window as any).__exportResult = result
      })
    }, {
      entries: dates.map(date => datedEntryResponse(date, `content ${date}`)),
    })

    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(4)
    await expect.poll(async () => page.evaluate(() => (window as any).__exportResult?.length ?? 0)).toBe(6)

    const resultDates = await page.evaluate(() => (window as any).__exportResult.map((entry: { date: string }) => entry.date))
    expect(resultDates).toEqual(dates)
    expect(await page.evaluate(() => window.diaryHarness.progressCalls())).toHaveLength(6)
  })

  test('exportAll with txt format returns plain content without frontmatter', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })

    await page.evaluate((entry) => {
      window.diaryHarness.q({ status: 200, body: entry })
      ;(window as any).__exportResult = null
      void window.diaryHarness.exportAll('txt').then(result => {
        ;(window as any).__exportResult = result
      })
    }, datedEntryResponse('2026-05-01', 'hello world'))

    await expect.poll(() => page.evaluate(() => (window as any).__exportResult?.length ?? 0)).toBe(1)
    const content = await page.evaluate(() => (window as any).__exportResult[0].content)
    expect(content).toBe('hello world')
    expect(content).not.toContain('---')
  })

  test('exportAll with md format returns content with YAML frontmatter', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })

    await page.evaluate((entry) => {
      window.diaryHarness.q({ status: 200, body: entry })
      ;(window as any).__exportResult = null
      void window.diaryHarness.exportAll('md').then(result => {
        ;(window as any).__exportResult = result
      })
    }, datedEntryResponse('2026-05-01', 'hello world'))

    await expect.poll(() => page.evaluate(() => (window as any).__exportResult?.length ?? 0)).toBe(1)
    const content = await page.evaluate(() => (window as any).__exportResult[0].content)
    expect(content).toContain('---\ndate: 2026-05-01\nupdated_at: 2026-05-01T00:00:00.000Z\n---')
    expect(content).toContain('hello world')
  })
})

test.describe('useDiary refreshEntries', () => {
  test('refreshes the entry list from Drive without requiring a remount', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate((files) => {
      window.diaryHarness.q({
        status: 200,
        body: { files },
      })
      return window.diaryHarness.refreshEntries()
    }, [datedFileMeta('2026-05-03'), datedFileMeta('2026-05-02')])

    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-03,2026-05-02')
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/drive/entries')
  })
})

test.describe('useDiary IDB cache — eviction callback', () => {
  // These tests use refreshEntries to trigger loadEntryList after content is in memory cache.
  // The eviction mechanism is the same whether content came from IDB or getContent.

  test('fires onEntriesEvicted when Drive returns a newer version than cached content', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })

    // Load content into memory cache
    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello', updated_at: '' }, meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })

    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    // Refresh: Drive now returns a newer version → content must be evicted
    await page.evaluate(async () => {
      window.diaryHarness.q({ status: 200, body: { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '2' }] } })
      await window.diaryHarness.refreshEntries()
    })

    expect(await page.evaluate(() => window.diaryHarness.evictedCalls())).toEqual([['2026-05-01']])
  })

  test('does not fire onEntriesEvicted when Drive returns the same version', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello', updated_at: '' }, meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })

    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    await page.evaluate(async () => {
      window.diaryHarness.q({ status: 200, body: { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] } })
      await window.diaryHarness.refreshEntries()
    })

    expect(await page.evaluate(() => window.diaryHarness.evictedCalls())).toEqual([])
  })

  test('fires onEntriesEvicted when an entry is deleted on another device', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello', updated_at: '' }, meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })

    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    // Refresh: Drive returns empty list — entry was deleted on another device
    await page.evaluate(async () => {
      window.diaryHarness.q({ status: 200, body: { files: [] } })
      await window.diaryHarness.refreshEntries()
    })

    expect(await page.evaluate(() => window.diaryHarness.evictedCalls())).toEqual([['2026-05-01']])
  })
})

test.describe('useDiary IDB cache — cross-account isolation', () => {
  // Tests use a real page reload to persist IDB between sessions (realistic scenario).

  test('clears IDB when signed-in account differs from stored user', async ({ page }) => {
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

    // Session 2: reload page (IDB preserved), sign in as a different account
    await reloadHarness(page)
    await page.evaluate(async () => {
      window.diaryHarness.setEmail('other@example.com')
      window.diaryHarness.q({ status: 200, body: { files: [] } })
      window.diaryHarness.start()
    })
    await page.waitForSelector('#harness-ready')

    // IDB was cleared: no dates from user@example.com's session visible
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '')
    const stored = await page.evaluate(() => localStorage.getItem('linger_session_user'))
    expect(stored).toBe('other@example.com')
  })

  test('does not hydrate IDB when the signed-in account email is unknown', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(async () => {
      window.diaryHarness.seedLocalStorageUser('user@example.com')
      await window.diaryHarness.seedIdb([{
        date: '2026-05-01',
        meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' },
        content: { date: '2026-05-01', content: 'cached secret', updated_at: '' },
        snippet: 'cached secret',
      }])
      window.diaryHarness.setEmail(null)
      window.diaryHarness.q({ status: 200, body: { files: [] } })
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
      window.diaryHarness.q({ status: 200, body: { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] } })
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
      window.diaryHarness.q({ status: 200, body: { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] }, delayMs: 500 })
      window.diaryHarness.start()
    })

    // Entry from IDB should appear well within the 500ms Drive delay
    await expect(page.locator('[data-dates="2026-05-01"]')).toBeVisible({ timeout: 300 })
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
        { status: 200, body: { files } },
        ...entries.map(entry => ({ status: 200, body: entry })),
      )
      window.diaryHarness.start()
    }, {
      files: dates.map(d => datedFileMeta(d)),
      entries: dates.map(d => datedEntryResponse(d, `content ${d}`)),
    })

    await page.waitForSelector('#harness-ready')
    // 1 list call + 3 prefetch content calls
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(4)
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
        { status: 200, body: { files } },
        ...entries.map(entry => ({ status: 200, body: entry })),
      )
      window.diaryHarness.start()
    }, {
      files: dates.map(d => datedFileMeta(d)),
      entries: ['2026-05-05', '2026-05-04', '2026-05-03'].map(d => datedEntryResponse(d, `content ${d}`)),
    })

    await page.waitForSelector('#harness-ready')
    // 1 list + exactly 3 prefetch calls — 4th and 5th entries must not be attempted
    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(4)

    const calls = await page.evaluate(() => window.diaryHarness.calls())
    const prefetchUrls = calls.slice(1).map((c: { url: string }) => c.url)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-05'))).toBe(true)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-04'))).toBe(true)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-03'))).toBe(true)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-02'))).toBe(false)
    expect(prefetchUrls.some((u: string) => u.includes('2026-05-01'))).toBe(false)
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
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    // Force with existing cache should go straight to save
    expect(calls[0].method).toBe('POST')
    expect(calls).toHaveLength(1)
  })
})
