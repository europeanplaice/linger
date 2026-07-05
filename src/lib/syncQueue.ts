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

  async process(handler: (item: QueueItem) => Promise<boolean>): Promise<void> {
    const items = [...this.queue];
    for (const item of items) {
      try {
        const success = await handler(item);
        if (success) {
          await this.dequeue(item.id);
        }
      } catch {
        break;
      }
    }
  }
}
