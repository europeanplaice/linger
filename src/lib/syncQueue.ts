export interface QueueItem {
  id: string;
  type: 'SAVE' | 'REMOVE';
  date: string;
  content?: string;
  baseVersion?: string | null;
  timestamp: number;
}

const STORAGE_KEY = 'linger_pending_sync_queue';

export class SyncQueueManager {
  private queue: QueueItem[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.queue = parsed;
        } else {
          this.queue = [];
        }
      }
    } catch {
      this.queue = [];
    }
  }

  private save(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
    } catch {
      // Storage quota or restriction error
    }
  }

  async enqueue(item: QueueItem): Promise<void> {
    this.queue = this.queue.filter((i) => i.date !== item.date);
    this.queue.push(item);
    this.save();
  }

  async dequeue(id: string): Promise<void> {
    this.queue = this.queue.filter((i) => i.id !== id);
    this.save();
  }

  async getPending(): Promise<QueueItem[]> {
    return [...this.queue];
  }

  // Drops every queued item. Called on sign-out and account switch — a
  // REMOVE queued by one account must never replay against another one.
  async clear(): Promise<void> {
    this.queue = [];
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage restriction error
    }
  }

  // Handler contract: resolve true → item synced (dequeued), resolve false →
  // stop processing (e.g. went offline again), throw → this item failed but
  // the rest are independent dates, so keep going and rethrow at the end.
  async process(handler: (item: QueueItem) => Promise<boolean>): Promise<void> {
    const items = [...this.queue];
    const errors: unknown[] = [];
    let processed = false;
    for (const item of items) {
      let success: boolean;
      try {
        success = await handler(item);
      } catch (e) {
        errors.push(e);
        continue;
      }
      if (!success) break;
      this.queue = this.queue.filter((i) => i.id !== item.id);
      processed = true;
    }
    if (processed) this.save();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to sync some queued diary changes');
    }
  }
}
