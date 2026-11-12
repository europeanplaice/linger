import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { confirmLegacyUpgrade, getDatabaseNotice, getDiaryDatabase } from '../../src/lib/diaryCache'

describe('legacy database upgrade', () => {
  it('waits for explicit acknowledgement before notifying an older connection', async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('linger_diary_cache', 3)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('entries', { keyPath: 'date' })
        req.result.createObjectStore('drafts', { keyPath: 'date' })
        req.result.createObjectStore('accountDrafts', { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const changed = vi.fn(() => old.close())
    old.onversionchange = changed
    const upgrade = getDiaryDatabase()
    await vi.waitFor(() => expect(getDatabaseNotice()).toBe('confirm-upgrade'))
    expect(changed).not.toHaveBeenCalled()
    confirmLegacyUpgrade()
    const db = await upgrade
    expect(changed).toHaveBeenCalledOnce()
    expect(db.objectStoreNames.contains('secureRecords')).toBe(true)
    expect(getDatabaseNotice()).toBeNull()
  })
})
