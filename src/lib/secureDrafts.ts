import { getAccountSnapshot } from './accountSession'
import { getAllDrafts as getAllLegacyDrafts, getDraft as getLegacyDraft } from './diaryCache'
import type { DraftEntry } from './diaryCache'
import {
  deleteEncryptedLocal, listEncryptedLocal, LocalWriteConflictError, migrateEncryptedDraft,
  readEncryptedLocal, verifyDraftKey, writeEncryptedLocal,
} from './encryptedLocalStore'
import type { DraftKeyGuard } from './encryptedLocalStore'
import { getVaultRevision, getVaultUserId } from './passkeyVault'

const KIND = 'draft'
const pendingWrites = new Map<string, Promise<void>>()

function sameOwner(a: string, b: string): boolean { return a.trim().toLowerCase() === b.trim().toLowerCase() }

/** Bind every operation to the server-verified Google account and this vault. */
function context(owner: string): { userId: string; assertCurrent: () => void } {
  const account = getAccountSnapshot()
  const userId = getVaultUserId()
  const revision = getVaultRevision()
  if (!owner || !account.account || !account.verifiedEmail || !sameOwner(account.verifiedEmail, owner) || !userId) {
    throw new Error('A verified account and unlocked passkey are required for drafts')
  }
  return {
    userId,
    assertCurrent: () => {
      if (getAccountSnapshot() !== account || getVaultUserId() !== userId || getVaultRevision() !== revision) {
        throw new Error('Account or passkey changed during draft operation')
      }
    },
  }
}

async function prepare(owner: string) {
  const state = context(owner)
  const guard = await verifyDraftKey(owner, state.userId, state.assertCurrent)
  state.assertCurrent()
  return { ...state, guard }
}

/** Move any unchanged legacy copies before returning an encrypted result. */
async function migrate(owner: string, userId: string, guard: DraftKeyGuard, assertCurrent: () => void, date?: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const legacy = date ? [await getLegacyDraft(date, owner)].filter((value): value is DraftEntry => !!value) : await getAllLegacyDrafts(owner)
    assertCurrent()
    if (legacy.length === 0) return
    for (const draft of legacy) {
      if (!draft.owner || !sameOwner(draft.owner, owner)) throw new Error('Legacy draft owner does not match')
      await migrateEncryptedDraft(userId, draft, guard, assertCurrent)
      assertCurrent()
    }
  }
  throw new Error('A legacy draft keeps changing; retry after closing other tabs')
}

export async function getSecureDraft(owner: string, date: string): Promise<DraftEntry | undefined> {
  const state = await prepare(owner)
  await migrate(owner, state.userId, state.guard, state.assertCurrent, date)
  const result = await readEncryptedLocal<DraftEntry>(state.userId, KIND, date)
  state.assertCurrent()
  if (result && (!result.value.owner || !sameOwner(result.value.owner, owner))) throw new Error('Stored draft owner does not match')
  return result?.value
}

export async function getAllSecureDrafts(owner: string): Promise<DraftEntry[]> {
  const state = await prepare(owner)
  await migrate(owner, state.userId, state.guard, state.assertCurrent)
  const result = await listEncryptedLocal<DraftEntry>(state.userId, KIND)
  state.assertCurrent()
  if (result.some(row => !row.value.owner || !sameOwner(row.value.owner, owner))) throw new Error('Stored draft owner does not match')
  return result.map(row => row.value).sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSecureDraft(draft: DraftEntry): Promise<void> {
  if (!draft.owner) throw new Error('A verified draft owner is required')
  const owner = draft.owner
  const captured = context(owner)
  const key = JSON.stringify([captured.userId, owner, draft.date])
  const previous = pendingWrites.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    captured.assertCurrent()
    const state = await prepare(owner)
    await migrate(owner, state.userId, state.guard, state.assertCurrent, draft.date)
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await readEncryptedLocal<DraftEntry>(state.userId, KIND, draft.date)
      state.assertCurrent()
      if (existing && (!existing.value.owner || !sameOwner(existing.value.owner, owner))) throw new Error('Stored draft owner does not match')
      if (existing && (existing.value.savedAt > draft.savedAt ||
          (existing.value.savedAt === draft.savedAt && existing.value.content !== draft.content))) {
        throw new Error('A newer or concurrent draft already exists')
      }
      try {
        await writeEncryptedLocal(state.userId, KIND, draft.date, draft, existing?.revision ?? null, state.guard, state.assertCurrent)
        state.assertCurrent()
        return
      } catch (error) {
        if (!(error instanceof LocalWriteConflictError) || attempt === 3) throw error
        state.assertCurrent()
      }
    }
  })
  pendingWrites.set(key, pending)
  try { await pending } finally { if (pendingWrites.get(key) === pending) pendingWrites.delete(key) }
}

export async function deleteSecureDraft(owner: string, date: string, expectedContent?: string, expectedSavedAt?: number): Promise<void> {
  const state = await prepare(owner)
  await migrate(owner, state.userId, state.guard, state.assertCurrent, date)
  const existing = await readEncryptedLocal<DraftEntry>(state.userId, KIND, date)
  state.assertCurrent()
  if (existing && (!existing.value.owner || !sameOwner(existing.value.owner, owner))) throw new Error('Stored draft owner does not match')
  if (!existing || (expectedContent !== undefined && existing.value.content !== expectedContent)) return
  if (expectedSavedAt !== undefined && existing.value.savedAt !== expectedSavedAt) return
  await deleteEncryptedLocal(state.userId, KIND, date, existing.revision, state.guard, state.assertCurrent)
  state.assertCurrent()
}

export async function markSecureDraftConflicted(expected: DraftEntry): Promise<boolean> {
  if (!expected.owner) return false
  const state = await prepare(expected.owner)
  await migrate(expected.owner, state.userId, state.guard, state.assertCurrent, expected.date)
  const existing = await readEncryptedLocal<DraftEntry>(state.userId, KIND, expected.date)
  state.assertCurrent()
  if (existing && (!existing.value.owner || !sameOwner(existing.value.owner, expected.owner))) throw new Error('Stored draft owner does not match')
  if (!existing || existing.value.content !== expected.content || existing.value.savedAt !== expected.savedAt ||
      existing.value.baseVersion !== expected.baseVersion || existing.value.baseContent !== expected.baseContent ||
      existing.value.conflicted !== expected.conflicted) return false
  await writeEncryptedLocal(state.userId, KIND, expected.date, { ...existing.value, conflicted: true }, existing.revision, state.guard, state.assertCurrent)
  state.assertCurrent()
  return true
}
