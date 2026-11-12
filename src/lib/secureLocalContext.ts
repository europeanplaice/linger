import { getAccountSnapshot } from './accountSession'
import { verifyDraftKey } from './encryptedLocalStore'
import { getVaultRevision, getVaultUserId } from './passkeyVault'

export function sameLocalOwner(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Capture a verified account and fail if it or the unlocked key changes. */
export function captureLocalContext(owner?: string) {
  const account = getAccountSnapshot()
  const userId = getVaultUserId()
  const revision = getVaultRevision()
  const verifiedOwner = account.verifiedEmail
  if (!verifiedOwner || !account.account || !userId || (owner && !sameLocalOwner(owner, verifiedOwner))) {
    throw new Error('A verified account and unlocked passkey are required for local data')
  }
  return {
    userId,
    owner: verifiedOwner,
    assertCurrent: () => {
      if (getAccountSnapshot() !== account || getVaultUserId() !== userId || getVaultRevision() !== revision) {
        throw new Error('Account or passkey changed during local data operation')
      }
    },
  }
}

export async function prepareLocalContext(owner?: string) {
  const state = captureLocalContext(owner)
  const guard = await verifyDraftKey(state.owner, state.userId, state.assertCurrent)
  state.assertCurrent()
  return { ...state, guard }
}
