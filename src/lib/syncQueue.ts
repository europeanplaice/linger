import { SecureLocalData } from './secureLocalData'
import { captureLocalContext } from './secureLocalContext'
import { canRecoverLegacyOwner, LEGACY_QUEUE_KEY, LEGACY_QUEUE_OWNER_KEY, readLegacyOwner, updateLocalSessionOwner } from './localSessionOwner'

export interface QueueItem {
  id: string
  type: 'SAVE' | 'REMOVE'
  date: string
  content?: string
  baseVersion?: string | null
  fileId?: string
  timestamp: number
}

const ITEM_PREFIX = 'linger_pending_sync_item:'

function validItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<QueueItem>
  return typeof item.id === 'string' && typeof item.date === 'string' &&
    (item.type === 'SAVE' || item.type === 'REMOVE') && typeof item.timestamp === 'number'
}

export class SyncQueueManager {
  private readonly records: SecureLocalData<QueueItem>
  private readonly prefix: string

  constructor(private readonly owner?: string) {
    this.records = new SecureLocalData('sync-queue', owner)
    this.prefix = ITEM_PREFIX + encodeURIComponent(owner ?? '') + ':'
  }

  /** Copy unchanged account-scoped legacy records before removing plaintext. */
  private async migrateLegacy(allowUnscoped = false): Promise<void> {
    if (!this.owner) {
      if (allowUnscoped) throw new Error('A verified account is required')
      return
    }
    const context = captureLocalContext(this.owner)
    let legacyOwner: string | null = null
    const sources: Array<{ key: string; raw: string; items: QueueItem[] }> = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(this.prefix)) continue
      const raw = localStorage.getItem(key)
      if (raw === null) continue
      let value: unknown
      try { value = JSON.parse(raw) } catch { throw new Error('Invalid legacy sync operation') }
      if (!validItem(value)) throw new Error('Invalid legacy sync operation')
      sources.push({ key, raw, items: [value] })
    }
    if (allowUnscoped) {
      await updateLocalSessionOwner(undefined, () => { context.assertCurrent(); return true })
      legacyOwner = readLegacyOwner(LEGACY_QUEUE_OWNER_KEY)
      if (!await canRecoverLegacyOwner(legacyOwner, context.owner)) throw new Error('Legacy queue belongs to another account')
      const raw = localStorage.getItem(LEGACY_QUEUE_KEY)
      if (raw !== null) {
        try {
          const value: unknown = JSON.parse(raw)
          if (Array.isArray(value) && value.every(validItem)) sources.push({ key: LEGACY_QUEUE_KEY, raw, items: value })
        } catch { /* Preserve malformed recovery data. */ }
      }
    }
    for (const source of sources) {
      for (const item of source.items) {
        context.assertCurrent()
        if (source.key === LEGACY_QUEUE_KEY && readLegacyOwner(LEGACY_QUEUE_OWNER_KEY) !== legacyOwner) throw new Error('Legacy queue owner changed during recovery')
        await this.records.update(item.id, current => {
          if (current && JSON.stringify(current) !== JSON.stringify(item)) throw new Error('Conflicting legacy sync operation requires recovery')
          return current ?? item
        })
      }
      context.assertCurrent()
      // localStorage and IndexedDB cannot share a transaction. Only delete a
      // source if it has not changed since the successful encrypted writes.
      if (localStorage.getItem(source.key) === source.raw && (source.key !== LEGACY_QUEUE_KEY ||
          readLegacyOwner(LEGACY_QUEUE_OWNER_KEY) === legacyOwner)) {
        localStorage.removeItem(source.key)
        if (source.key === LEGACY_QUEUE_KEY) localStorage.removeItem(LEGACY_QUEUE_OWNER_KEY)
      }
    }
  }

  /** Import an unscoped queue only after an explicit user decision. */
  async recoverLegacy(): Promise<void> {
    await this.migrateLegacy(true)
    if (localStorage.getItem(LEGACY_QUEUE_KEY) !== null) throw new Error('Legacy queue could not be imported')
  }

  async getPending(): Promise<QueueItem[]> {
    await this.migrateLegacy()
    const items = await this.records.list()
    if (!items.every(validItem)) throw new Error('Invalid encrypted sync operation')
    return items.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  }

  async enqueue(item: QueueItem): Promise<void> {
    if (!validItem(item)) throw new Error('Invalid sync operation')
    await this.migrateLegacy()
    // Keep each operation individually: no queued change is silently removed
    // by a concurrent tab. Processing checks server-side versions.
    await this.records.update(item.id, current => {
      if (current && JSON.stringify(current) !== JSON.stringify(item)) throw new Error('Sync operation ID already exists')
      return current ?? item
    })
  }

  async dequeue(id: string): Promise<void> {
    await this.records.remove(id)
  }

  async clear(): Promise<void> {
    for (const item of await this.getPending()) await this.records.remove(item.id, current => JSON.stringify(current) === JSON.stringify(item))
  }

  async process(handler: (item: QueueItem) => Promise<boolean>): Promise<void> {
    const run = async () => {
      const errors: unknown[] = []
      for (const item of await this.getPending()) {
        if (!(await this.getPending()).some(pending => pending.id === item.id)) continue
        try {
          if (!await handler(item)) break
          await this.records.remove(item.id, current => JSON.stringify(current) === JSON.stringify(item))
        } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Failed to sync some queued diary changes')
    }
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('linger-sync:' + (this.owner ?? ''), run)
    } else {
      await run()
    }
  }
}
