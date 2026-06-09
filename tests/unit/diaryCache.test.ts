import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAllCached, putCached, deleteCached, clearCache, getDraft, getAllDrafts, putDraft, deleteDraft } from '../../src/lib/diaryCache'
import type { CachedEntry, DraftEntry } from '../../src/lib/diaryCache'

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

const draft: DraftEntry = {
  date: '2026-05-01',
  content: 'offline edit',
  baseVersion: '3',
  baseContent: 'previous text',
  savedAt: 1750000000000,
}

describe('diaryCache drafts', () => {
  it('roundtrips a draft', async () => {
    await putDraft(draft)
    expect(await getDraft('2026-05-01')).toEqual(draft)
    expect(await getAllDrafts()).toEqual([draft])
  })

  it('getDraft returns undefined for a missing date', async () => {
    expect(await getDraft('2026-05-02')).toBeUndefined()
  })

  it('overwrites an existing draft for the same date', async () => {
    await putDraft(draft)
    await putDraft({ ...draft, content: 'newer edit', conflicted: true })
    const stored = await getDraft('2026-05-01')
    expect(stored?.content).toBe('newer edit')
    expect(stored?.conflicted).toBe(true)
    expect(await getAllDrafts()).toHaveLength(1)
  })

  it('deleteDraft removes only the targeted date', async () => {
    await putDraft(draft)
    await putDraft({ ...draft, date: '2026-05-02' })
    await deleteDraft('2026-05-01')
    expect((await getAllDrafts()).map(d => d.date)).toEqual(['2026-05-02'])
  })

  it('drafts are independent of the entries store', async () => {
    await putDraft(draft)
    await putCached(entry)
    await deleteCached('2026-05-01')
    expect(await getDraft('2026-05-01')).toEqual(draft)
  })

  it('clearCache wipes drafts as well as entries', async () => {
    await putCached(entry)
    await putDraft(draft)
    await clearCache()
    expect(await getAllCached()).toEqual([])
    expect(await getAllDrafts()).toEqual([])
  })
})
