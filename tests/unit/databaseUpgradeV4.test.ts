import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { confirmLegacyUpgrade, getDatabaseNotice, getDiaryDatabase } from '../../src/lib/diaryCache'

it('adds the owner index to the previous encrypted schema without losing records', async () => {
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('linger_diary_cache', 4)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('entries', { keyPath: 'date' })
      db.createObjectStore('drafts', { keyPath: 'date' })
      db.createObjectStore('accountDrafts', { keyPath: 'key' })
      const secure = db.createObjectStore('secureRecords', { keyPath: 'key' })
      secure.createIndex('group', 'group')
      secure.put({ key: 'old-draft', group: 'group', revision: 'r', envelope: { version: 1, iv: 'old', ciphertext: 'ciphertext' } })
      db.createObjectStore('draftKeyMarkers', { keyPath: 'ownerHash' })
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
  const store = db.transaction('secureRecords').objectStore('secureRecords')
  expect(store.indexNames.contains('owner')).toBe(true)
  const row = await new Promise<unknown>((resolve, reject) => {
    const req = store.get('old-draft')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  expect(row).toMatchObject({ key: 'old-draft', envelope: { ciphertext: 'ciphertext' } })
})
