import {
  deleteEncryptedLocal, listEncryptedLocal, LocalWriteConflictError,
  readEncryptedLocal, writeEncryptedLocal,
} from './encryptedLocalStore'
import { prepareLocalContext } from './secureLocalContext'

/** Shared account-bound encrypted records for local application data. */
export class SecureLocalData<T> {
  constructor(private readonly kind: string, private readonly owner?: string) {}

  private scopedKind(ownerHash: string): string { return `${this.kind}:${ownerHash}` }

  async get(id: string): Promise<T | null> {
    const state = await prepareLocalContext(this.owner)
    const row = await readEncryptedLocal<T>(state.userId, this.scopedKind(state.guard.ownerHash), id)
    state.assertCurrent()
    return row?.value ?? null
  }

  async list(): Promise<T[]> {
    const state = await prepareLocalContext(this.owner)
    const rows = await listEncryptedLocal<T>(state.userId, this.scopedKind(state.guard.ownerHash))
    state.assertCurrent()
    return rows.map(row => row.value)
  }

  /** Save only if the record has not changed since it was read. */
  async update(id: string, transform: (current: T | null) => T): Promise<T> {
    const state = await prepareLocalContext(this.owner)
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readEncryptedLocal<T>(state.userId, this.scopedKind(state.guard.ownerHash), id)
      state.assertCurrent()
      const next = transform(current?.value ?? null)
      try {
        await writeEncryptedLocal(state.userId, this.scopedKind(state.guard.ownerHash), id, next, current?.revision ?? null, state.guard, state.assertCurrent)
        state.assertCurrent()
        return next
      } catch (error) {
        if (!(error instanceof LocalWriteConflictError) || attempt === 4) throw error
        state.assertCurrent()
      }
    }
    throw new Error('Unable to update local data')
  }

  async remove(id: string, matches: (current: T) => boolean = () => true): Promise<boolean> {
    const state = await prepareLocalContext(this.owner)
    const current = await readEncryptedLocal<T>(state.userId, this.scopedKind(state.guard.ownerHash), id)
    state.assertCurrent()
    if (!current || !matches(current.value)) return false
    const deleted = await deleteEncryptedLocal(state.userId, this.scopedKind(state.guard.ownerHash), id, current.revision, state.guard, state.assertCurrent)
    state.assertCurrent()
    return deleted
  }
}
