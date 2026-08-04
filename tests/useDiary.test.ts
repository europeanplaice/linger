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
      void window.diaryHarness.exportAll().then(result => {
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

  test('exportAll returns the bare body text (no frontmatter)', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })

    await page.evaluate((entry) => {
      window.diaryHarness.q({ status: 200, body: entry })
      ;(window as any).__exportResult = null
      void window.diaryHarness.exportAll().then(result => {
        ;(window as any).__exportResult = result
      })
    }, datedEntryResponse('2026-05-01', 'hello world'))

    await expect.poll(() => page.evaluate(() => (window as any).__exportResult?.length ?? 0)).toBe(1)
    const content = await page.evaluate(() => (window as any).__exportResult[0].content)
    expect(content).toBe('hello world')
  })
})

test.describe('useDiary importAll', () => {
  test('imports new entries with bounded parallel requests', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06']
    await page.evaluate(({ metas, dates }) => {
      window.diaryHarness.q(...metas.map(meta => ({ status: 200, body: meta, delayMs: 200 })))
      ;(window as any).__importResult = null
      void window.diaryHarness.importAll(dates.map(date => ({ date, content: `content ${date}` }))).then(result => {
        ;(window as any).__importResult = result
      })
    }, { metas: dates.map(date => datedFileMeta(date)), dates })

    await expect.poll(async () => (await page.evaluate(() => window.diaryHarness.calls())).length).toBe(4)
    await expect.poll(async () => page.evaluate(() => (window as any).__importResult !== null)).toBe(true)

    const result = await page.evaluate(() => (window as any).__importResult)
    expect(result.ok).toBe(true)
    expect([...result.result.imported].sort()).toEqual(dates)
    expect(result.result.skipped).toEqual([])
    expect(result.result.failed).toEqual([])
    expect(await page.evaluate(() => window.diaryHarness.progressCalls())).toHaveLength(6)
  })

  test('skips dates that already exist locally without a network call', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01'), datedFileMeta('2026-05-02')] })
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate((meta) => {
      window.diaryHarness.q({ status: 200, body: meta })
      ;(window as any).__importResult = null
      void window.diaryHarness.importAll([
        { date: '2026-05-01', content: 'existing 1' },
        { date: '2026-05-02', content: 'existing 2' },
        { date: '2026-05-03', content: 'new entry' },
      ]).then(result => { (window as any).__importResult = result })
    }, datedFileMeta('2026-05-03'))

    await expect.poll(async () => page.evaluate(() => (window as any).__importResult !== null)).toBe(true)
    expect((await page.evaluate(() => window.diaryHarness.calls())).length).toBe(1)

    const result = await page.evaluate(() => (window as any).__importResult)
    expect(result.ok).toBe(true)
    expect(result.result.imported).toEqual(['2026-05-03'])
    expect([...result.result.skipped].sort()).toEqual(['2026-05-01', '2026-05-02'])
    expect(result.result.failed).toEqual([])
  })

  test('treats a 409 conflict response as skipped, not failed', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 409, body: { conflict: null } })
      ;(window as any).__importResult = null
      void window.diaryHarness.importAll([{ date: '2026-05-01', content: 'raced entry' }]).then(result => {
        (window as any).__importResult = result
      })
    })

    await expect.poll(async () => page.evaluate(() => (window as any).__importResult !== null)).toBe(true)
    const result = await page.evaluate(() => (window as any).__importResult)
    expect(result.ok).toBe(true)
    expect(result.result.skipped).toEqual(['2026-05-01'])
    expect(result.result.imported).toEqual([])
    expect(result.result.failed).toEqual([])
  })

  test('collects per-entry failures without aborting the batch', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate((meta) => {
      window.diaryHarness.q(
        { status: 200, body: meta },
        { status: 400, body: 'bad request' },
      )
      ;(window as any).__importResult = null
      void window.diaryHarness.importAll([
        { date: '2026-05-01', content: 'ok entry' },
        { date: '2026-05-02', content: 'bad entry' },
      ]).then(result => { (window as any).__importResult = result })
    }, datedFileMeta('2026-05-01'))

    await expect.poll(async () => page.evaluate(() => (window as any).__importResult !== null)).toBe(true)
    const result = await page.evaluate(() => (window as any).__importResult)
    expect(result.ok).toBe(true)
    expect(result.result.imported).toEqual(['2026-05-01'])
    expect(result.result.failed).toEqual(['2026-05-02'])
    expect(result.result.skipped).toEqual([])
  })

  test('propagates a token-expiry failure and notifies the app', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())
    await page.evaluate(() => window.diaryHarness.clearExpiredCalls())

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 401, body: {} })
      ;(window as any).__importResult = null
      void window.diaryHarness.importAll([{ date: '2026-05-01', content: 'entry' }]).then(result => {
        (window as any).__importResult = result
      })
    })

    await expect.poll(async () => page.evaluate(() => (window as any).__importResult !== null)).toBe(true)
    const result = await page.evaluate(() => (window as any).__importResult)
    expect(result.ok).toBe(false)
    expect(await page.evaluate(() => window.diaryHarness.expiredCalls())).toBe(1)
  })
})

function change(date: string, version = '1', removed = false, id = `file-${date}`) {
  return {
    fileId: id,
    removed,
    file: removed ? undefined : { id, name: `diary-${date}.md`, version },
  }
}

test.describe('useDiary refreshEntries', () => {
  test('applies new entries from the Changes API without requiring a remount', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate((changes) => {
      window.diaryHarness.q({
        status: 200,
        body: { changes, newStartPageToken: 'tok-2' },
      })
      return window.diaryHarness.refreshEntries()
    }, [change('2026-05-03'), change('2026-05-02')])

    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-03,2026-05-02,2026-05-01')
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/drive/changes')
  })

  test('does nothing when the Changes API returns no changes (token init)', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-01')] })
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { changes: [], newStartPageToken: 'tok-1' } })
      return window.diaryHarness.refreshEntries()
    })

    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-01')
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/drive/changes')
  })

  test('removes a deleted entry reported by the Changes API', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [datedFileMeta('2026-05-02'), datedFileMeta('2026-05-01')] })
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-02,2026-05-01')
    await page.evaluate(() => window.diaryHarness.clearCalls())

    await page.evaluate((changes) => {
      window.diaryHarness.q({ status: 200, body: { changes, newStartPageToken: 'tok-2' } })
      return window.diaryHarness.refreshEntries()
    }, [change('2026-05-01', '1', true)])

    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '2026-05-02')
  })

  test('evicts content for an entry whose version changed', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-2026-05-01', name: 'diary-2026-05-01.md', version: '1' }] })

    // Load content into memory cache
    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello' }, meta: { id: 'file-2026-05-01', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })
    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    // Changes API reports the file at a newer version → content must be evicted
    await page.evaluate((changes) => {
      window.diaryHarness.q({ status: 200, body: { changes, newStartPageToken: 'tok-2' } })
      return window.diaryHarness.refreshEntries()
    }, [change('2026-05-01', '2')])

    expect(await page.evaluate(() => window.diaryHarness.evictedCalls())).toEqual([['2026-05-01']])

    // Next getContent should hit the network (content was evicted)
    await page.evaluate(() => window.diaryHarness.clearCalls())
    const refreshed = await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'updated' }, meta: { id: 'file-2026-05-01', name: 'diary-2026-05-01.md', version: '2' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })
    expect(refreshed?.entry.content).toBe('updated')
    expect(await page.evaluate(() => window.diaryHarness.calls())).toHaveLength(1)
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
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello' }, meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })

    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    // Refresh: Changes API reports a newer version → content must be evicted
    await page.evaluate(async () => {
      window.diaryHarness.q({ status: 200, body: { changes: [{ fileId: 'file-1', removed: false, file: { id: 'file-1', name: 'diary-2026-05-01.md', version: '2' } }], newStartPageToken: 'tok-2' } })
      await window.diaryHarness.refreshEntries()
    })

    expect(await page.evaluate(() => window.diaryHarness.evictedCalls())).toEqual([['2026-05-01']])
  })

  test('does not fire onEntriesEvicted when Drive returns the same version', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello' }, meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })

    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    await page.evaluate(async () => {
      window.diaryHarness.q({ status: 200, body: { changes: [{ fileId: 'file-1', removed: false, file: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } }], newStartPageToken: 'tok-2' } })
      await window.diaryHarness.refreshEntries()
    })

    expect(await page.evaluate(() => window.diaryHarness.evictedCalls())).toEqual([])
  })

  test('fires onEntriesEvicted when an entry is deleted on another device', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page, { files: [{ id: 'file-1', name: 'diary-2026-05-01.md', version: '1' }] })

    await page.evaluate(() => {
      window.diaryHarness.q({ status: 200, body: { entry: { date: '2026-05-01', content: 'hello' }, meta: { id: 'file-1', name: 'diary-2026-05-01.md', version: '1' } } })
      return window.diaryHarness.triggerGetContent('2026-05-01')
    })

    await page.evaluate(() => window.diaryHarness.clearEvictedCalls())

    // Refresh: Changes API reports the file removed — deleted on another device
    await page.evaluate(async () => {
      window.diaryHarness.q({ status: 200, body: { changes: [{ fileId: 'file-1', removed: true }], newStartPageToken: 'tok-2' } })
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

    // The save also mirrored the entry into localStorage
    const mirrored = await page.evaluate(() => localStorage.getItem('linger_local_entry_2026-05-01'))
    expect(mirrored).toContain('secret diary')

    // Session 2: reload page (IDB preserved), sign in as a different account.
    // A REMOVE left queued by the previous account must not survive either —
    // it would replay against the new account's Drive.
    await reloadHarness(page)
    await page.evaluate(async () => {
      localStorage.setItem('linger_pending_sync_queue', JSON.stringify([
        { id: 'remove-2026-05-01-1', type: 'REMOVE', date: '2026-05-01', timestamp: Date.now() },
      ]))
      window.diaryHarness.setEmail('other@example.com')
      window.diaryHarness.q({ status: 200, body: { files: [] } })
      window.diaryHarness.start()
    })
    await page.waitForSelector('#harness-ready')

    // IDB was cleared: no dates from user@example.com's session visible
    await expect(page.locator('#harness-ready')).toHaveAttribute('data-dates', '')
    const stored = await page.evaluate(() => localStorage.getItem('linger_session_user'))
    expect(stored).toBe('other@example.com')
    // The local entry mirror and offline queue were wiped with the cache
    expect(await page.evaluate(() => localStorage.getItem('linger_local_entry_2026-05-01'))).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('linger_pending_sync_queue'))).toBeNull()
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
    await context.setOffline(false)
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q(
        { status: 400, body: { error: 'server error' } },
        { status: 200, body: meta },
      )
      window.dispatchEvent(new Event('online'))
    }, { meta: datedFileMeta('2026-05-02', '1') })

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

test.describe('useDiary retryPendingSave — session expiry flow', () => {
  test('retryPendingSave replays the pending content after a 401 save failure', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Save hits a 401 → stores the pending save and fires onExpired
    const failed = await page.evaluate(() => {
      window.diaryHarness.q({ status: 401, body: {} })
      return window.diaryHarness.save('2026-05-01', 'my diary text', null)
    })
    expect(failed.ok).toBe(false)

    const expiredCount = await page.evaluate(() => window.diaryHarness.expiredCalls())
    expect(expiredCount).toBeGreaterThan(0)

    // Clear the 401 call record so only the retry appears below
    await page.evaluate(() => window.diaryHarness.clearCalls())

    // Re-auth completes → call retryPendingSave with a success response
    const retry = await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
      return window.diaryHarness.retryPendingSave()
    }, { meta: fileMeta('1') })

    expect(retry).toMatchObject({ ok: true })

    // The replayed save must have used the original content, not an empty string
    const calls = await page.evaluate(() => window.diaryHarness.calls())
    const saveCall = calls.find((c: { url: string; method: string; body?: string }) =>
      c.url.includes('2026-05-01') && c.method === 'POST')
    if (!saveCall) throw new Error('Expected the pending save to be replayed')
    const body = JSON.parse(saveCall.body ?? '{}') as { content?: string }
    expect(body.content).toBe('my diary text')
  })

  test('retryPendingSave returns null when there is no pending save', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    const result = await page.evaluate(() => window.diaryHarness.retryPendingSave())
    expect(result).toMatchObject({ ok: true, result: null })
  })

  test('retryPendingSave clears the pending save so a second call returns null', async ({ page }) => {
    await loadHarness(page)
    await startHarness(page)

    // First: induce a 401 to store a pending save
    await page.evaluate(() => {
      window.diaryHarness.q({ status: 401, body: {} })
      return window.diaryHarness.save('2026-05-01', 'once only', null)
    })

    // First retry succeeds
    await page.evaluate(({ meta }) => {
      window.diaryHarness.q({ status: 200, body: meta })
      return window.diaryHarness.retryPendingSave()
    }, { meta: fileMeta('1') })

    // Second retry: pending is cleared, should be null
    const second = await page.evaluate(() => window.diaryHarness.retryPendingSave())
    expect(second).toMatchObject({ ok: true, result: null })
  })
})
