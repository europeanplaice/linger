import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAllCached, putCached, deleteCached, clearCache } from '../../src/lib/diaryCache'
import type { CachedEntry } from '../../src/lib/diaryCache'

const meta = (v: string, id = 'f1') => ({
  id,
  name: 'diary-2026-05-01.md',
  version: v,
})

const entry: CachedEntry = {
  date: '2026-05-01',
  meta: meta('1'),
  content: { date: '2026-05-01', content: 'hello' },
  snippet: 'hello',
}

beforeEach(async () => { await clearCache() })

describe('diaryCache', () => {
  it('roundtrips a cached entry', async () => {
    await putCached(entry)
    const all = await getAllCached()
    expect(all).toEqual([entry])
  })

  it('overwrites an existing entry with the same date key', async () => {
    await putCached({ date: '2026-05-01', meta: meta('1') })
    await putCached({ date: '2026-05-01', meta: meta('2'), snippet: 'updated' })
    const all = await getAllCached()
    expect(all).toHaveLength(1)
    expect(all[0].meta.version).toBe('2')
    expect(all[0].snippet).toBe('updated')
  })

  it('delete removes only the targeted date', async () => {
    await putCached({ date: '2026-05-01', meta: meta('1', 'f1') })
    await putCached({ date: '2026-05-02', meta: { id: 'f2', name: 'diary-2026-05-02.md', version: '1' } })
    await deleteCached('2026-05-01')
    const all = await getAllCached()
    expect(all.map(e => e.date)).toEqual(['2026-05-02'])
  })

  it('clear empties the store', async () => {
    await putCached(entry)
    await clearCache()
    expect(await getAllCached()).toEqual([])
  })

  it('allows list-only entries without content or snippet', async () => {
    await putCached({ date: '2026-05-01', meta: meta('1') })
    const all = await getAllCached()
    expect(all[0].content).toBeUndefined()
    expect(all[0].snippet).toBeUndefined()
  })

  it('getAllCached returns empty array when store is empty', async () => {
    expect(await getAllCached()).toEqual([])
  })
})
