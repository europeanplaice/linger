import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiFetch, deleteEntry } from '../../src/api/driveEntries'
import { accountRequest, AUTH_EVENT_KEY, getAccountSnapshot, setActiveAccount, subscribeAccountChanges } from '../../src/lib/accountSession'

vi.mock('../../src/utils/tabSync', () => ({ broadcastMessage: vi.fn(), subscribeTabSync: () => () => {} }))

beforeEach(() => { localStorage.clear(); setActiveAccount('sub:a') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('captures the account for a request rather than reading the cookie account later', () => {
  const request = accountRequest()
  setActiveAccount('sub:b')
  expect(new Headers(request.init.headers).get('X-Linger-Account')).toBe('sub:a')
  expect(request.assertCurrent).toThrow()
})

it('stops a scheduled API retry when the tab account changes', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockResolvedValue(new Response('temporary', { status: 503 }))
  vi.stubGlobal('fetch', fetchMock)
  const pending = apiFetch('/api/drive/entries')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  setActiveAccount('sub:b')
  await vi.runAllTimersAsync()
  await rejected
  expect(fetchMock).toHaveBeenCalledOnce()
})

it.each(['GET', 'DELETE'])('invalidates local authentication when the server rejects %s account binding', async method => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401, headers: { 'X-Linger-Account-Changed': '1' } })))
  const invalidated = vi.fn()
  const unsubscribe = subscribeAccountChanges(vi.fn(), invalidated)
  try {
    await expect(method === 'DELETE' ? deleteEntry('2026-05-01') : apiFetch('/api/drive/entries')).rejects.toMatchObject({ name: 'AbortError' })
    expect(getAccountSnapshot().account).toBeNull()
    expect(invalidated).toHaveBeenCalledOnce()
  } finally { unsubscribe() }
})

it('does not return a successful body if the account changed while reading it', async () => {
  let resolve!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, headers: new Headers(), json: () => new Promise(r => { resolve = r }),
  }))
  const pending = apiFetch('/api/drive/entries')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  setActiveAccount('sub:b')
  resolve({ private: 'a' })
  await rejected
})

it('ignores older notifications after observing a newer shared auth event', () => {
  const changed = vi.fn()
  const unsubscribe = subscribeAccountChanges(changed, vi.fn())
  try {
    localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ id: 'new', account: 'sub:b' }))
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_EVENT_KEY }))
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_EVENT_KEY, newValue: JSON.stringify({ id: 'old', account: null }) }))
    expect(changed).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledWith({ id: 'new', account: 'sub:b' })
  } finally { unsubscribe() }
})
