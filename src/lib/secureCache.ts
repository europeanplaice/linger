import { getAllCached as getLegacyCached } from './diaryCache'
import type { CachedEntry } from './diaryCache'
import { migrateEncryptedCache } from './encryptedLocalStore'
import { SecureLocalData } from './secureLocalData'
import { captureLocalContext, prepareLocalContext, sameLocalOwner } from './secureLocalContext'

const records = new SecureLocalData<CachedEntry>('diary-cache')
const pending = new Map<string, Promise<void>>()

function ordered(date: string, operation: () => Promise<void>): Promise<void> {
  const context = captureLocalContext()
  const key = JSON.stringify([context.userId, context.owner.toLowerCase(), date])
  const previous = pending.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => { context.assertCurrent(); await operation() })
  pending.set(key, next)
  void next.finally(() => { if (pending.get(key) === next) pending.delete(key) }).catch(() => {})
  return next
}

async function waitPending(): Promise<void> {
  const context = captureLocalContext()
  const prefix = `[${JSON.stringify(context.userId)},${JSON.stringify(context.owner.toLowerCase())},`
  await Promise.all([...pending].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value))
  context.assertCurrent()
}

async function migrate(): Promise<void> {
  const state = await prepareLocalContext()
  const legacy = await getLegacyCached()
  state.assertCurrent()
  for (const entry of legacy) {
    if (entry.owner && sameLocalOwner(entry.owner, state.owner)) {
      await migrateEncryptedCache(state.userId, entry, state.guard, state.assertCurrent)
    }
  }
}

export async function getAllCached(): Promise<CachedEntry[]> {
  await waitPending()
  await migrate()
  return records.list()
}

export async function putCached(entry: CachedEntry): Promise<void> {
  return ordered(entry.date, async () => {
    const state = await prepareLocalContext(entry.owner)
    if (!entry.owner || !sameLocalOwner(entry.owner, state.owner)) throw new Error('A verified cache owner is required')
    await migrate()
    state.assertCurrent()
    await records.update(entry.date, () => entry)
  })
}

export async function deleteCached(date: string): Promise<void> {
  return ordered(date, async () => {
    await migrate()
    await records.remove(date)
  })
}

export async function clearCache(): Promise<void> {
  await waitPending()
  await migrate()
  for (const entry of await records.list()) {
    await records.remove(entry.date, current => JSON.stringify(current) === JSON.stringify(entry))
  }
}

/** Ownerless old cache rows are only claimed after an explicit user choice. */
export async function hasLegacyCache(): Promise<boolean> {
  await migrate()
  const state = await prepareLocalContext()
  const rows = await getLegacyCached()
  state.assertCurrent()
  return rows.some(row => !row.owner || sameLocalOwner(row.owner, state.owner))
}

export async function recoverLegacyCache(): Promise<void> {
  const state = await prepareLocalContext()
  const rows = await getLegacyCached()
  for (const row of rows) {
    state.assertCurrent()
    if (row.owner && !sameLocalOwner(row.owner, state.owner)) continue
    const recovered = { ...row, owner: state.owner }
    if (!await migrateEncryptedCache(state.userId, row, state.guard, state.assertCurrent, recovered)) {
      throw new Error('Legacy cache changed or conflicts with encrypted data')
    }
  }
  state.assertCurrent()
}
