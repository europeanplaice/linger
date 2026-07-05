import type { LoadedDiaryEntry } from '../types';

export interface StorageAdapter {
  getMode(): 'drive' | 'local' | 'fs';
  listEntries(): Promise<string[]>;
  getEntry(date: string): Promise<LoadedDiaryEntry | null>;
  saveEntry(date: string, content: string): Promise<LoadedDiaryEntry>;
  deleteEntry(date: string): Promise<void>;
}

const LOCAL_STORAGE_PREFIX = 'linger_local_entry_';
const LOCAL_STORAGE_INDEX = 'linger_local_entries_index';

export class LocalStorageAdapter implements StorageAdapter {
  getMode(): 'drive' | 'local' | 'fs' {
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

  async listEntries(): Promise<string[]> {
    return this.getIndex();
  }

  async getEntry(date: string): Promise<LoadedDiaryEntry | null> {
    try {
      const content = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${date}`);
      if (content === null) {
        return null;
      }
      return {
        entry: { date, content },
        meta: {
          id: `local-${date}`,
          name: `diary-${date}.txt`,
          version: '1',
          modifiedTime: new Date().toISOString(),
        },
      };
    } catch {
      return null;
    }
  }

  async saveEntry(date: string, content: string): Promise<LoadedDiaryEntry> {
    try {
      localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${date}`, content);
    } catch (e) {
      throw new Error('Local storage limit exceeded', { cause: e });
    }
    const index = this.getIndex();
    if (!index.includes(date)) {
      index.push(date);
      this.setIndex(index);
    }
    return {
      entry: { date, content },
      meta: {
        id: `local-${date}`,
        name: `diary-${date}.txt`,
        version: String(Date.now()),
        modifiedTime: new Date().toISOString(),
      },
    };
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
