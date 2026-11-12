import 'fake-indexeddb/auto'
import { StrictMode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useMilestones } from '../../src/hooks/useMilestones'
import { loadMilestones, saveMilestones } from '../../src/api/driveMilestones'
import { setActiveAccount } from '../../src/lib/accountSession'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { SecureLocalData } from '../../src/lib/secureLocalData'

vi.mock('../../src/api/driveMilestones', () => ({
  loadMilestones: vi.fn(), saveMilestones: vi.fn(),
  TokenExpiredError: class TokenExpiredError extends Error {},
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

let email: string
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  email = `${crypto.randomUUID()}@example.com`
  setActiveAccount(`email:${email}`, false, email)
  unlockVaultWithKey(email, new Uint8Array(32).fill(13))
  vi.mocked(loadMilestones).mockResolvedValue([])
  vi.mocked(saveMilestones).mockResolvedValue()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, callback: () => Promise<void>) => callback() } })
})
afterEach(() => { cleanup(); clearVaultKey(); setActiveAccount(null); vi.restoreAllMocks() })

async function open() {
  const hook = renderHook(() => useMilestones('signedIn', vi.fn(), email))
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  return hook
}

test('does not expose or import unattributed old milestones until requested', async () => {
  const raw = JSON.stringify([{ id: 'legacy', label: 'Birthday', monthDay: '05-10' }])
  localStorage.setItem('linger_milestones', raw)
  const hook = await open()
  expect(hook.result.current.milestones).toEqual([])
  expect(hook.result.current.legacyAvailable).toBe(true)
  expect(localStorage.getItem('linger_milestones')).toBe(raw)
  act(() => hook.result.current.recoverLegacy())
  await waitFor(() => expect(localStorage.getItem('linger_milestones')).toBeNull())
  expect(hook.result.current.milestones).toEqual([{ id: 'legacy', label: 'Birthday', date: '2000-05-10' }])
  expect((await new SecureLocalData<{list: unknown[]}>('milestones').get('list'))?.list).toEqual(hook.result.current.milestones)
})

test('preserves malformed legacy records instead of silently dropping entries', async () => {
  const raw = JSON.stringify([{ id: 'ok', label: 'Good', date: '2020-05-10' }, { id: 'bad', date: 'invalid' }])
  localStorage.setItem('linger_milestones', raw)
  const hook = await open()
  act(() => hook.result.current.recoverLegacy())
  expect(hook.result.current.storageError).toBe(true)
  expect(localStorage.getItem('linger_milestones')).toBe(raw)
  expect(saveMilestones).not.toHaveBeenCalled()
})

test('keeps a legacy source and reports a failed encrypted write', async () => {
  const raw = JSON.stringify([{ id: 'legacy', label: 'Important date', date: '2020-05-10' }])
  localStorage.setItem('linger_milestones', raw)
  const hook = await open()
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  act(() => hook.result.current.recoverLegacy())
  await waitFor(() => expect(hook.result.current.storageError).toBe(true))
  expect(localStorage.getItem('linger_milestones')).toBe(raw)
  expect(saveMilestones).not.toHaveBeenCalled()
  put.mockRestore()
})

test('limits registrations to fifty and enables at most five badges', async () => {
  const hook = await open()
  act(() => {
    for (let i = 1; i <= 51; i++) hook.result.current.add(`Milestone ${i}`, `2020-${String((i % 12) + 1).padStart(2, '0')}-01`)
  })
  expect(hook.result.current.milestones).toHaveLength(50)
  expect(hook.result.current.milestones.filter(a => a.showBadge !== false)).toHaveLength(5)
  act(() => hook.result.current.toggleBadge(hook.result.current.milestones[5].id))
  expect(hook.result.current.milestones[5].showBadge).toBe(false)
  await waitFor(async () => {
    const record = await new SecureLocalData<{ list: unknown[]; pending: boolean }>('milestones').get('list')
    expect(record?.list).toHaveLength(50)
    expect(record?.pending).toBe(false)
  }, { timeout: 10000 })
}, 15000)

test('serializes saves so an older request cannot finish after a newer one', async () => {
  const firstSave = deferred<void>()
  vi.mocked(saveMilestones).mockImplementationOnce(() => firstSave.promise).mockResolvedValueOnce()
  const hook = renderHook(() => useMilestones('signedIn', vi.fn(), email), { wrapper: StrictMode })
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  act(() => { hook.result.current.add('First', '2020-05-10') })
  await waitFor(() => expect(saveMilestones).toHaveBeenCalledTimes(1))
  expect(vi.mocked(saveMilestones).mock.calls[0][0].map(a => a.label)).toEqual(['First'])
  act(() => { hook.result.current.add('Second', '2021-06-11') })
  await waitFor(async () => {
    const record = await new SecureLocalData<{list: {label: string}[]}>('milestones').get('list')
    expect(record?.list.map(item => item.label)).toEqual(['First', 'Second'])
  })
  firstSave.resolve()
  await waitFor(() => expect(saveMilestones).toHaveBeenCalledTimes(2))
  expect(vi.mocked(saveMilestones).mock.calls[1][0].map(a => a.label)).toEqual(['First', 'Second'])
})

test('blocks edits until the first Drive load or encrypted cache has been read', async () => {
  const load = deferred<Awaited<ReturnType<typeof loadMilestones>>>()
  vi.mocked(loadMilestones).mockReturnValue(load.promise)
  const hook = renderHook(() => useMilestones('signedIn', vi.fn(), email))
  await waitFor(() => expect(loadMilestones).toHaveBeenCalled())
  act(() => hook.result.current.add('Premature edit', '2020-05-10'))
  expect(hook.result.current.milestones).toEqual([])
  load.resolve([{ id: 'remote', label: 'Remote', date: '2019-01-01' }])
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  expect(hook.result.current.milestones.map(a => a.label)).toEqual(['Remote'])
})

test('retries encrypted pending changes before loading Drive state', async () => {
  const pending = [{ id: 'local', label: 'Pending local', date: '2020-05-10' }]
  await new SecureLocalData('milestones').update('list', () => ({ list: pending, pending: true, changeId: 'pending' }))
  await open()
  await waitFor(() => expect(saveMilestones).toHaveBeenCalledWith(pending))
  expect(loadMilestones).not.toHaveBeenCalled()
  await waitFor(async () => expect((await new SecureLocalData<{pending: boolean}>('milestones').get('list'))?.pending).toBe(false))
})

test('keeps encrypted pending changes when remote saving fails', async () => {
  vi.mocked(saveMilestones).mockRejectedValueOnce(new Error('offline'))
  const hook = await open()
  act(() => hook.result.current.add('Private offline event', '2020-05-10'))
  await waitFor(() => expect(hook.result.current.syncError).toBe(true))
  const record = await new SecureLocalData<{pending: boolean; list: {label: string}[]}>('milestones').get('list')
  expect(record?.pending).toBe(true)
  expect(record?.list[0].label).toBe('Private offline event')
  expect(JSON.stringify(localStorage)).not.toContain('Private offline event')
})

test('does not sync without a cross-tab lock and preserves the encrypted change', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  const hook = await open()
  act(() => hook.result.current.add('Pending edit', '2020-05-10'))
  await waitFor(() => expect(hook.result.current.syncError).toBe(true))
  expect(saveMilestones).not.toHaveBeenCalled()
  expect((await new SecureLocalData<{pending: boolean}>('milestones').get('list'))?.pending).toBe(true)
})
