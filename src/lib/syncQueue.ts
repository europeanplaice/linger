export interface QueueItem {
  id: string
  type: 'SAVE' | 'REMOVE'
  date: string
  content?: string
  baseVersion?: string | null
  timestamp: number
}

const LEGACY_KEY = 'linger_pending_sync_queue'
const ITEM_PREFIX = 'linger_pending_sync_item:'

export class SyncQueueManager {
  private fallback = new Map<string, QueueItem>()
  private readonly prefix: string

  constructor(private readonly owner?: string) {
    this.prefix = ITEM_PREFIX + encodeURIComponent(owner ?? '') + ':'
    this.migrateLegacy()
  }

  private key(id: string): string { return this.prefix + encodeURIComponent(id) }

  private migrateLegacy(): void {
    try {
      if (this.owner !== undefined && localStorage.getItem('linger_session_user') !== this.owner) return
      const raw = localStorage.getItem(LEGACY_KEY)
      if (!raw) return
      const items = JSON.parse(raw)
      if (!Array.isArray(items)) return
      for (const item of items) {
        if (typeof item?.id === 'string' && typeof item.date === 'string') this.fallback.set(item.id, item)
      }
      for (const item of items) {
        if (typeof item?.id === 'string' && typeof item.date === 'string') {
          if (!localStorage.getItem(this.key(item.id))) localStorage.setItem(this.key(item.id), JSON.stringify(item))
          this.fallback.delete(item.id)
        }
      }
      localStorage.removeItem(LEGACY_KEY)
    } catch { /* Keep the legacy record if migration cannot finish. */ }
  }

  async getPending(): Promise<QueueItem[]> {
    try {
      const items: QueueItem[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith(this.prefix)) continue
        try {
          const item = JSON.parse(localStorage.getItem(key) ?? 'null')
          if (item && typeof item.id === 'string' && typeof item.date === 'string') items.push(item)
        } catch { /* Skip a corrupt record without dropping other operations. */ }
      }
      const pending = new Map(items.map(item => [item.id, item]))
      this.fallback.forEach((item, id) => pending.set(id, item))
      return [...pending.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    } catch { return [...this.fallback.values()] }
  }

  async enqueue(item: QueueItem): Promise<void> {
    const previous = await this.getPending()
    for (const old of previous) { if (old.date === item.date) this.fallback.delete(old.id) }
    try {
      localStorage.setItem(this.key(item.id), JSON.stringify(item))
      for (const old of previous) {
        if (old.date === item.date && old.id !== item.id) localStorage.removeItem(this.key(old.id))
      }
    } catch { this.fallback.set(item.id, item) }
  }

  async dequeue(id: string): Promise<void> {
    this.fallback.delete(id)
    try { localStorage.removeItem(this.key(id)) } catch { /* Storage unavailable. */ }
  }

  async clear(): Promise<void> {
    this.fallback.clear()
    try {
      const keys = Object.keys(localStorage).filter(key => key.startsWith(this.prefix))
      keys.forEach(key => localStorage.removeItem(key))
      localStorage.removeItem(LEGACY_KEY)
    } catch { /* Storage unavailable. */ }
  }

  async process(handler: (item: QueueItem) => Promise<boolean>): Promise<void> {
    const run = async () => {
      const errors: unknown[] = []
      for (const item of await this.getPending()) {
        // Another tab may have cleared/replaced this item while we were waiting.
        if (!(await this.getPending()).some(pending => pending.id === item.id)) continue
        try {
          if (!await handler(item)) break
          // Delete only this operation; never overwrite a queue snapshot.
          await this.dequeue(item.id)
        } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Failed to sync some queued diary changes')
    }
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('linger-sync:' + (this.owner ?? ''), run)
    } else {
      // Older browsers retain every operation; duplicate DELETEs are idempotent.
      await run()
    }
  }
}
