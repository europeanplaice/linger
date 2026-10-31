import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useDiary, EntryConflictError } from '../../src/hooks/useDiary'
import * as api from '../../src/api/driveEntries'
import { clearCache, getAllCached } from '../../src/lib/diaryCache'
import { SyncQueueManager } from '../../src/lib/syncQueue'

vi.mock('../../src/api/driveEntries', async original => ({
  ...await original<typeof import('../../src/api/driveEntries')>(),
  listEntries: vi.fn(), getEntryByDate: vi.fn(), deleteEntry: vi.fn(),
  getChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: '' }),
}))
vi.mock('../../src/utils/tabSync', () => ({ broadcastMessage: vi.fn() }))

const date = '2026-10-31'
const meta = { id: 'file-original', name: `diary-${date}.txt`, version: '7' }
const loaded = { meta, entry: { date, content: 'original' } }
const owner = 'a@example.com'

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('linger_session_user', owner)
  await clearCache()
  vi.mocked(api.listEntries).mockResolvedValue([meta])
  vi.mocked(api.getEntryByDate).mockResolvedValue(loaded)
  vi.mocked(api.deleteEntry).mockResolvedValue(undefined)
})
afterEach(async () => { cleanup(); await clearCache() })

async function diary() {
  const hook = renderHook(() => useDiary('signedIn', owner, vi.fn()))
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  return hook
}

it('uses the editor deletion snapshot even when the hook has a newer cached version', async () => {
  const hook = await diary()
  const expected = { fileId: 'older-file', baseVersion: '1' }
  await act(async () => { await hook.result.current.remove(date, expected) })
  expect(api.deleteEntry).toHaveBeenCalledWith(date, expect.any(AbortSignal), expected)
})

it('persists the exact file identity and version with an offline deletion', async () => {
  const hook = await diary()
  vi.mocked(api.deleteEntry).mockRejectedValueOnce(new TypeError('offline'))
  await act(async () => { await expect(hook.result.current.remove(date)).rejects.toThrow('offline') })
  expect(await new SyncQueueManager(owner).getPending()).toMatchObject([{ type: 'REMOVE', date, fileId: meta.id, baseVersion: '7' }])
})

it('cancels an old queued delete when the server reports a newer entry', async () => {
  const queue = new SyncQueueManager(owner)
  await queue.enqueue({ id: 'old-delete', type: 'REMOVE', date, fileId: 'old-file', baseVersion: '1', timestamp: 1 })
  vi.mocked(api.deleteEntry).mockRejectedValueOnce(new api.SaveConflictError(loaded))
  const hook = await diary()
  await waitFor(() => expect(hook.result.current.deletionCancelled).toBe(true))
  expect(await queue.getPending()).toEqual([])
  expect(hook.result.current.dates).toContain(date)
  expect((await getAllCached()).some(entry => entry.date === date)).toBe(true)
})

it('cancels legacy queued deletes that cannot identify the intended version', async () => {
  const queue = new SyncQueueManager(owner)
  await queue.enqueue({ id: 'legacy-delete', type: 'REMOVE', date, timestamp: 1 })
  const hook = await diary()
  await waitFor(() => expect(hook.result.current.deletionCancelled).toBe(true))
  expect(api.deleteEntry).not.toHaveBeenCalled()
  expect(await queue.getPending()).toEqual([])
})

it('surfaces a deletion conflict without removing the entry or queuing a retry', async () => {
  const hook = await diary()
  vi.mocked(api.deleteEntry).mockRejectedValueOnce(new api.SaveConflictError(loaded))
  await act(async () => { await expect(hook.result.current.remove(date)).rejects.toBeInstanceOf(EntryConflictError) })
  expect(hook.result.current.dates).toContain(date)
  expect(await new SyncQueueManager(owner).getPending()).toEqual([])
})

it('rejects an expired-session delete so the editor does not treat it as successful', async () => {
  const hook = await diary()
  vi.mocked(api.deleteEntry).mockRejectedValueOnce(new api.TokenExpiredError())
  await act(async () => { await expect(hook.result.current.remove(date)).rejects.toBeInstanceOf(api.TokenExpiredError) })
  expect(hook.result.current.dates).toContain(date)
  expect(await new SyncQueueManager(owner).getPending()).toEqual([])
})
