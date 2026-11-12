import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setActiveAccount } from '../../src/lib/accountSession'
import { getDraft, putDraft } from '../../src/lib/diaryCache'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { deleteSecureDraft, getAllSecureDrafts, getSecureDraft, markSecureDraftConflicted, putSecureDraft } from '../../src/lib/secureDrafts'
import { nextDraftCheckpointTime } from '../../src/lib/draftStorage'

afterEach(() => { clearVaultKey(); setActiveAccount(null); vi.restoreAllMocks() })

function unlock(owner: string, userId: string, fill = 7): void {
  unlockVaultWithKey(userId, new Uint8Array(32).fill(fill))
  setActiveAccount(`email:${owner}`, false, owner)
}

describe('secure drafts', () => {
  it('orders same-tab checkpoints when the clock has not advanced', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const first = nextDraftCheckpointTime()
    expect(nextDraftCheckpointTime()).toBe(first + 1)
  })
  it('migrates the authenticated owner’s legacy draft and handles conditional updates', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    const userId = crypto.randomUUID()
    const draft = { owner, date: '2026-01-02', content: 'private draft', baseVersion: null, baseContent: 'old content', savedAt: 1 }
    await putDraft(draft)
    unlock(owner, userId)
    expect(await getSecureDraft(owner, draft.date)).toEqual(draft)
    expect(await getDraft(draft.date, owner)).toBeUndefined()
    expect(await getAllSecureDrafts(owner)).toEqual([draft])
    const newer = { ...draft, content: 'newer draft', savedAt: 2 }
    await putSecureDraft(newer)
    await expect(putSecureDraft({ ...newer, content: 'concurrent draft' })).rejects.toThrow('concurrent draft')
    expect((await getSecureDraft(owner, draft.date))?.content).toBe('newer draft')
    await deleteSecureDraft(owner, draft.date, newer.content, draft.savedAt)
    expect((await getSecureDraft(owner, draft.date))?.savedAt).toBe(newer.savedAt)
    await deleteSecureDraft(owner, draft.date, draft.content)
    expect(await markSecureDraftConflicted(draft)).toBe(false)
    expect(await markSecureDraftConflicted(newer)).toBe(true)
    expect((await getSecureDraft(owner, draft.date))?.conflicted).toBe(true)
    await deleteSecureDraft(owner, draft.date, newer.content)
    expect(await getSecureDraft(owner, draft.date)).toBeUndefined()
  })

  it('rejects a different verified account, a locked vault, and a replacement passkey vault', async () => {
    const owner = `${crypto.randomUUID()}@example.com`
    const userId = crypto.randomUUID()
    const draft = { owner, date: '2026-01-03', content: 'private draft', baseVersion: null, baseContent: null, savedAt: 1 }
    unlock(owner, userId)
    await putSecureDraft(draft)
    setActiveAccount('other-account', false, 'someone-else@example.com')
    await expect(getSecureDraft(owner, draft.date)).rejects.toThrow('verified account')
    unlock(owner, crypto.randomUUID(), 9)
    await expect(getSecureDraft(owner, draft.date)).rejects.toThrow('saved drafts cannot be opened')
    clearVaultKey()
    await expect(getSecureDraft(owner, draft.date)).rejects.toThrow('unlocked passkey')
    unlock(owner, userId)
    expect((await getSecureDraft(owner, draft.date))?.content).toBe(draft.content)
  })
})
