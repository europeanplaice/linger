import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { deleteEncryptedLocal, listEncryptedLocal, migrateEncryptedDraft, readEncryptedLocal, verifyDraftKey, writeEncryptedLocal } from '../../src/lib/encryptedLocalStore'
import { getDraft, putDraft } from '../../src/lib/diaryCache'

afterEach(() => { clearVaultKey(); vi.restoreAllMocks() })

describe('encrypted local store', () => {
  it('keeps content and identifiers out of stored records and rejects stale writes', async () => {
    const userId = 'local-test-user'
    const id = crypto.randomUUID()
    unlockVaultWithKey(userId, new Uint8Array(32).fill(9))
    const first = await writeEncryptedLocal(userId, 'draft', id, { content: 'private diary text' }, null)
    expect((await readEncryptedLocal<{ content: string }>(userId, 'draft', id))?.value.content).toBe('private diary text')
    const next = await writeEncryptedLocal(userId, 'draft', id, { content: 'newer text' }, first)
    expect(await listEncryptedLocal(userId, 'draft')).toContainEqual({ value: { content: 'newer text' }, revision: next })
    await expect(writeEncryptedLocal(userId, 'draft', id, { content: 'older text' }, first)).rejects.toThrow('changed')
    expect(await deleteEncryptedLocal(userId, 'draft', id, first)).toBe(false)

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('linger_diary_cache')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('secureRecords').objectStore('secureRecords').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('newer text')
    expect(serialized).not.toContain(id)
    expect(serialized).not.toContain(userId)
    expect(serialized).not.toContain('draft')
    db.close()
    expect(await deleteEncryptedLocal(userId, 'draft', id, next)).toBe(true)
    expect(await readEncryptedLocal(userId, 'draft', id)).toBeNull()
  })

  it('allows only one concurrent writer to update the same revision', async () => {
    const id = crypto.randomUUID()
    unlockVaultWithKey('concurrent', new Uint8Array(32).fill(3))
    const revision = await writeEncryptedLocal('concurrent', 'draft', id, 'original', null)
    const results = await Promise.allSettled([
      writeEncryptedLocal('concurrent', 'draft', id, 'first', revision),
      writeEncryptedLocal('concurrent', 'draft', id, 'second', revision),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(['first', 'second']).toContain((await readEncryptedLocal('concurrent', 'draft', id))?.value)
  })

  it('does not read data while locked or under a different key', async () => {
    const id = crypto.randomUUID()
    unlockVaultWithKey('account', new Uint8Array(32).fill(1))
    await writeEncryptedLocal('account', 'draft', id, 'private', null)
    clearVaultKey()
    await expect(readEncryptedLocal('account', 'draft', id)).rejects.toThrow('Passkey unlock required')
    unlockVaultWithKey('account', new Uint8Array(32).fill(2))
    expect(await readEncryptedLocal('account', 'draft', id)).toBeNull()
  })

  it('distinguishes a replacement vault or incorrect key from an empty account', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    unlockVaultWithKey('old-vault', new Uint8Array(32).fill(1))
    await verifyDraftKey(owner, 'old-vault')
    await verifyDraftKey(owner.toUpperCase(), 'old-vault')
    await writeEncryptedLocal('old-vault', 'draft', 'test-draft', 'private', null)
    unlockVaultWithKey('new-vault', new Uint8Array(32).fill(2))
    await expect(verifyDraftKey(owner, 'new-vault')).rejects.toThrow('saved drafts cannot be opened')
    unlockVaultWithKey('old-vault', new Uint8Array(32).fill(2))
    await expect(verifyDraftKey(owner, 'old-vault')).rejects.toThrow('saved drafts cannot be opened')
    unlockVaultWithKey('old-vault', new Uint8Array(32).fill(1))
    await expect(verifyDraftKey(owner, 'old-vault')).resolves.toMatchObject({ revision: expect.any(String) })
  })

  it('allows a new vault when no drafts exist, and rejects an old tab’s stale marker', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    unlockVaultWithKey('old-empty', new Uint8Array(32).fill(1))
    const oldGuard = await verifyDraftKey(owner, 'old-empty')
    unlockVaultWithKey('new-empty', new Uint8Array(32).fill(2))
    const newGuard = await verifyDraftKey(owner, 'new-empty')
    expect(newGuard.revision).not.toBe(oldGuard.revision)
    unlockVaultWithKey('old-empty', new Uint8Array(32).fill(1))
    await expect(writeEncryptedLocal('old-empty', 'draft', 'late-write', 'unsynced', null, oldGuard)).rejects.toThrow('changed')
  })

  it('rejects tampering with the saved key marker', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    unlockVaultWithKey('marker-test', new Uint8Array(32).fill(11))
    const guard = await verifyDraftKey(owner, 'marker-test')
    await writeEncryptedLocal('marker-test', 'draft', '2026-01-01', 'private', null, guard)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('linger_diary_cache')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('draftKeyMarkers', 'readwrite')
      const store = tx.objectStore('draftKeyMarkers')
      const request = store.get(guard.ownerHash)
      request.onsuccess = () => store.put({ ...request.result, group: 'tampered' })
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    db.close()
    await expect(verifyDraftKey(owner, 'marker-test')).rejects.toThrow('saved drafts cannot be opened')
    expect((await readEncryptedLocal('marker-test', 'draft', '2026-01-01'))?.value).toBe('private')
  })

  it('migrates a matching legacy draft atomically and refuses a stale snapshot', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    const user = crypto.randomUUID()
    const draft = { owner, date: '2026-01-02', content: 'legacy secret', baseVersion: null, baseContent: null, savedAt: 1 }
    unlockVaultWithKey(user, new Uint8Array(32).fill(4))
    await verifyDraftKey(owner, user)
    await putDraft(draft)
    await putDraft({ ...draft, content: 'newer secret', savedAt: 2 })
    expect(await migrateEncryptedDraft(user, draft)).toBe(false)
    expect(await readEncryptedLocal(user, 'draft', draft.date)).toBeNull()
    const latest = (await getDraft(draft.date, owner))!
    expect(await migrateEncryptedDraft(user, latest)).toBe(true)
    expect(await getDraft(draft.date, owner)).toBeUndefined()
    expect((await readEncryptedLocal<typeof draft>(user, 'draft', draft.date))?.value.content).toBe('newer secret')
  })

  it('preserves the legacy draft if encrypted storage fails', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    const user = crypto.randomUUID()
    const draft = { owner, date: '2026-01-04', content: 'must survive', baseVersion: null, baseContent: null, savedAt: 1 }
    unlockVaultWithKey(user, new Uint8Array(32).fill(4))
    const guard = await verifyDraftKey(owner, user)
    await putDraft(draft)
    const add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'secureRecords') throw new DOMException('Storage full', 'QuotaExceededError')
      return add.apply(this, args)
    })
    await expect(migrateEncryptedDraft(user, draft, guard)).rejects.toThrow('Storage full')
    expect(await getDraft(draft.date, owner)).toEqual(draft)
    expect(await readEncryptedLocal(user, 'draft', draft.date)).toBeNull()
  })

  it('keeps both copies when legacy and encrypted drafts diverge', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    const user = crypto.randomUUID()
    const draft = { owner, date: '2026-01-06', content: 'legacy edits', baseVersion: null, baseContent: null, savedAt: 1 }
    const other = { ...draft, content: 'encrypted edits', savedAt: 2 }
    unlockVaultWithKey(user, new Uint8Array(32).fill(4))
    const guard = await verifyDraftKey(owner, user)
    await putDraft(draft)
    await writeEncryptedLocal(user, 'draft', draft.date, other, null, guard)
    await expect(migrateEncryptedDraft(user, draft, guard)).rejects.toThrow('drafts differ')
    expect(await getDraft(draft.date, owner)).toEqual(draft)
    expect((await readEncryptedLocal<typeof draft>(user, 'draft', draft.date))?.value).toEqual(other)
  })

  it('does not migrate or write after the verified account changes', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    const user = crypto.randomUUID()
    const draft = { owner, date: '2026-01-05', content: 'old account draft', baseVersion: null, baseContent: null, savedAt: 1 }
    unlockVaultWithKey(user, new Uint8Array(32).fill(4))
    const guard = await verifyDraftKey(owner, user)
    await putDraft(draft)
    const changed = () => { throw new Error('account changed') }
    await expect(migrateEncryptedDraft(user, draft, guard, changed)).rejects.toThrow('account changed')
    expect(await getDraft(draft.date, owner)).toEqual(draft)
    await expect(writeEncryptedLocal(user, 'draft', draft.date, draft, null, guard, changed)).rejects.toThrow('account changed')
    expect(await readEncryptedLocal(user, 'draft', draft.date)).toBeNull()
  })
})
