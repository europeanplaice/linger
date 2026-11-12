import type { LoadedDiaryEntry, StorageMode } from '../types'
import { SecureLocalData } from './secureLocalData'
import { prepareLocalContext, sameLocalOwner } from './secureLocalContext'

export interface StorageAdapter {
  getMode(): StorageMode
  listEntries(): Promise<string[]>
  getEntry(date: string): Promise<LoadedDiaryEntry | null>
  saveEntry(date: string, content: string): Promise<LoadedDiaryEntry>
  deleteEntry(date: string): Promise<void>
  clearAll(): Promise<void>
}

const LOCAL_STORAGE_PREFIX = 'linger_local_entry_'
const LOCAL_STORAGE_INDEX = 'linger_local_entries_index'

interface StoredEntry {
  date: string
  content: string
  version: string
  modifiedTime: string
}

export class LocalStorageAdapter implements StorageAdapter {
  private readonly records = new SecureLocalData<StoredEntry>('local-mirror')

  getMode(): StorageMode { return 'local' }

  private async migrate(allowLegacy = false): Promise<void> {
    if (!allowLegacy) return
    const state = await prepareLocalContext()
    const previousOwner = localStorage.getItem('linger_local_mirror_legacy_owner') ?? localStorage.getItem('linger_session_user')
    // These records predate account-bound storage. The user must explicitly
    // choose to import them; a known different owner is never imported.
    if (previousOwner && previousOwner !== '__unknown__' && !sameLocalOwner(previousOwner, state.owner)) throw new Error('Legacy mirror belongs to another account')
    const keys = Object.keys(localStorage).filter(key => key.startsWith(LOCAL_STORAGE_PREFIX))
    for (const key of keys) {
      state.assertCurrent()
      const date = key.slice(LOCAL_STORAGE_PREFIX.length)
      const raw = localStorage.getItem(key)
      if (!date || raw === null) continue
      let value: unknown
      try { value = JSON.parse(raw) } catch { value = raw }
      const old = value && typeof value === 'object' ? value as Partial<StoredEntry> : null
      const entry: StoredEntry = {
        date,
        content: typeof old?.content === 'string' ? old.content : raw,
        version: typeof old?.version === 'string' ? old.version : '1',
        modifiedTime: typeof old?.modifiedTime === 'string' ? old.modifiedTime : new Date(0).toISOString(),
      }
      await this.records.update(date, current => {
        if (current && JSON.stringify(current) !== JSON.stringify(entry)) throw new Error('Conflicting local mirror requires recovery')
        return current ?? entry
      })
      state.assertCurrent()
      const owner = localStorage.getItem('linger_local_mirror_legacy_owner') ?? localStorage.getItem('linger_session_user')
      if (owner === previousOwner && localStorage.getItem(key) === raw) localStorage.removeItem(key)
    }
    state.assertCurrent()
    const owner = localStorage.getItem('linger_local_mirror_legacy_owner') ?? localStorage.getItem('linger_session_user')
    if (owner === previousOwner && !Object.keys(localStorage).some(key => key.startsWith(LOCAL_STORAGE_PREFIX))) {
      localStorage.removeItem(LOCAL_STORAGE_INDEX)
      localStorage.removeItem('linger_local_mirror_legacy_owner')
    }
  }

  async recoverLegacy(): Promise<void> {
    await this.migrate(true)
    if (Object.keys(localStorage).some(key => key.startsWith(LOCAL_STORAGE_PREFIX))) throw new Error('Legacy mirror could not be imported')
  }

  private toLoadedEntry(record: StoredEntry): LoadedDiaryEntry {
    return {
      entry: { date: record.date, content: record.content },
      meta: { id: `local-${record.date}`, name: `diary-${record.date}.txt`, version: record.version, modifiedTime: record.modifiedTime },
    }
  }

  async listEntries(): Promise<string[]> {
    await this.migrate()
    return (await this.records.list()).map(entry => entry.date).sort().reverse()
  }

  async getEntry(date: string): Promise<LoadedDiaryEntry | null> {
    await this.migrate()
    const record = await this.records.get(date)
    return record ? this.toLoadedEntry(record) : null
  }

  async saveEntry(date: string, content: string): Promise<LoadedDiaryEntry> {
    await this.migrate()
    const record = await this.records.update(date, previous => ({
      date, content,
      version: String(previous ? Number(previous.version) + 1 : 1),
      modifiedTime: new Date().toISOString(),
    }))
    return this.toLoadedEntry(record)
  }

  async deleteEntry(date: string): Promise<void> {
    await this.migrate()
    await this.records.remove(date)
  }

  async clearAll(): Promise<void> {
    await this.migrate()
    for (const entry of await this.records.list()) {
      await this.records.remove(entry.date, current => JSON.stringify(current) === JSON.stringify(entry))
    }
  }
}
