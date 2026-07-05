import type { LoadedDiaryEntry, StorageMode } from '../types';

export interface StorageAdapter {
  getMode(): StorageMode;
  listEntries(): Promise<string[]>;
  getEntry(date: string): Promise<LoadedDiaryEntry | null>;
  saveEntry(date: string, content: string): Promise<LoadedDiaryEntry>;
  deleteEntry(date: string): Promise<void>;
}

const LOCAL_STORAGE_PREFIX = 'linger_local_entry_';
const LOCAL_STORAGE_INDEX = 'linger_local_entries_index';

interface StoredEntry {
  content: string;
  version: string;
  modifiedTime: string;
}

export class LocalStorageAdapter implements StorageAdapter {
  getMode(): StorageMode {
    return 'local';
  }

  private getIndex(): string[] {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_INDEX);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private setIndex(dates: string[]): void {
    const sorted = Array.from(new Set(dates)).sort().reverse();
    try {
      localStorage.setItem(LOCAL_STORAGE_INDEX, JSON.stringify(sorted));
    } catch {
      // Catch quota errors
    }
  }

  private readRecord(date: string): StoredEntry | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${date}`);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
        return {
          content: parsed.content,
          version: typeof parsed.version === 'string' ? parsed.version : '1',
          modifiedTime: typeof parsed.modifiedTime === 'string' ? parsed.modifiedTime : new Date(0).toISOString(),
        };
      }
    } catch {
      // Fall through: value predates the JSON record format
    }
    return { content: raw, version: '1', modifiedTime: new Date(0).toISOString() };
  }

  private toLoadedEntry(date: string, record: StoredEntry): LoadedDiaryEntry {
    return {
      entry: { date, content: record.content },
      meta: {
        id: `local-${date}`,
        name: `diary-${date}.txt`,
        version: record.version,
        modifiedTime: record.modifiedTime,
      },
    };
  }

  async listEntries(): Promise<string[]> {
    return this.getIndex();
  }

  async getEntry(date: string): Promise<LoadedDiaryEntry | null> {
    const record = this.readRecord(date);
    if (record === null) return null;
    return this.toLoadedEntry(date, record);
  }

  async saveEntry(date: string, content: string): Promise<LoadedDiaryEntry> {
    const previous = this.readRecord(date);
    const record: StoredEntry = {
      content,
      version: String(previous ? Number(previous.version) + 1 : 1),
      modifiedTime: new Date().toISOString(),
    };
    try {
      localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${date}`, JSON.stringify(record));
    } catch (e) {
      throw new Error('Local storage limit exceeded', { cause: e });
    }
    const index = this.getIndex();
    if (!index.includes(date)) {
      index.push(date);
      this.setIndex(index);
    }
    return this.toLoadedEntry(date, record);
  }

  async deleteEntry(date: string): Promise<void> {
    try {
      localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${date}`);
    } catch {
      // Ignore
    }
    const index = this.getIndex().filter((d) => d !== date);
    this.setIndex(index);
  }
}
