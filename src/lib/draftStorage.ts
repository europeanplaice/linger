import type { DraftEntry } from './diaryCache'
import { deleteSecureDraft, getAllSecureDrafts, getSecureDraft, markSecureDraftConflicted, putSecureDraft } from './secureDrafts'

let lastCheckpointTime = 0
export const DRAFT_STORAGE_ERROR_EVENT = 'linger-draft-storage-error'
export function reportDraftStorageError(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFT_STORAGE_ERROR_EVENT))
}
export function nextDraftCheckpointTime(): number {
  lastCheckpointTime = Math.max(Date.now(), lastCheckpointTime + 1)
  return lastCheckpointTime
}

function requireOwner(owner: string | undefined): string {
  if (!owner) throw new Error('A verified account is required for drafts')
  return owner
}

export function getDraft(date: string, owner?: string): Promise<DraftEntry | undefined> {
  return getSecureDraft(requireOwner(owner), date)
}

export function getAllDrafts(owner?: string): Promise<DraftEntry[]> {
  return getAllSecureDrafts(requireOwner(owner))
}

export function putDraft(draft: DraftEntry): Promise<void> { return putSecureDraft(draft) }
export function deleteDraft(date: string, owner?: string, expectedContent?: string, expectedSavedAt?: number): Promise<void> {
  return deleteSecureDraft(requireOwner(owner), date, expectedContent, expectedSavedAt)
}
export function markDraftConflicted(draft: DraftEntry): Promise<boolean> { return markSecureDraftConflicted(draft) }
