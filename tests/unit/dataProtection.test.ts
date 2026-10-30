import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useDiary } from '../../src/hooks/useDiary'
import * as api from '../../src/api/driveEntries'
import { clearCache, getAllCached, getAllDrafts } from '../../src/lib/diaryCache'
import * as diaryCache from '../../src/lib/diaryCache'
import { onRequest as middleware } from '../../functions/api/_middleware'
import { onRequestPost as logout } from '../../functions/auth/logout'
import { createFakeKV } from '../helpers/fakeKV'
import { getSession, saveSession, getValidAccessToken, invalidateSession, SessionRevokedError } from '../../functions/_shared/session'
import type { AuthStatus } from '../../src/hooks/useAuth'
import type { LoadedDiaryEntry } from '../../src/types'

vi.mock('../../src/api/driveEntries', () => ({
  listEntries: vi.fn().mockResolvedValue([]),
  getEntryByDate: vi.fn().mockResolvedValue(null),
  saveEntry: vi.fn(), deleteEntry: vi.fn(), searchEntries: vi.fn(),
  getChanges: vi.fn().mockResolvedValue({ changes: [] }),
  TokenExpiredError: class extends Error {},
  SaveConflictError: class extends Error {},
  DriveHttpError: class extends Error {},
}))
vi.mock('../../src/utils/tabSync', () => ({ broadcastMessage: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const secret: LoadedDiaryEntry = {
  entry: { date: '2026-05-01', content: 'Account A private diary' },
  meta: { id: 'account-A-file', name: 'diary-2026-05-01.txt', version: '1' },
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(api.listEntries).mockResolvedValue([])
  vi.mocked(api.getEntryByDate).mockResolvedValue(null)
  localStorage.clear()
  await clearCache()
})
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await clearCache(); vi.unstubAllGlobals() })

function diary() {
  return renderHook(({ status, email }) => useDiary(status, email, vi.fn()), {
    initialProps: { status: 'signedIn' as AuthStatus, email: 'a@example.com' },
  })
}

it('does not repopulate persistent diary cache after logout when an older read finishes', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const oldRead = deferred<LoadedDiaryEntry>()
  vi.mocked(api.getEntryByDate).mockReturnValueOnce(oldRead.promise)
  let pending!: Promise<LoadedDiaryEntry | null>
  await act(async () => { pending = hook.result.current.getContent(secret.entry.date) })
  const signal = vi.mocked(api.getEntryByDate).mock.calls.at(-1)?.[3]
  expect(signal?.aborted).toBe(false)
  await act(async () => hook.rerender({ status: 'signedOut', email: 'a@example.com' }))
  expect(signal?.aborted).toBe(true)
  expect(await getAllCached()).toEqual([])
  await act(async () => { oldRead.resolve(secret); await pending })
  expect(await getAllCached()).toEqual([])
})

it('does not show account A data to account B when an older read finishes after switching', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const oldRead = deferred<LoadedDiaryEntry>()
  vi.mocked(api.getEntryByDate).mockReturnValueOnce(oldRead.promise)
  let pending!: Promise<LoadedDiaryEntry | null>
  await act(async () => { pending = hook.result.current.getContent(secret.entry.date) })
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await act(async () => { oldRead.resolve(secret); await pending })
  const visibleToB = await hook.result.current.getContent(secret.entry.date)
  expect(visibleToB?.entry.content).not.toBe(secret.entry.content)
})

it('keeps a logged-out session deleted when an earlier API request finishes', async () => {
  const session = { google_sub: 'account-a', refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3_600_000 }
  const kv = createFakeKV({ 'session:a': JSON.stringify(session) })
  const env = { SESSIONS: kv, SESSION_DOMAIN: 'https://app.example.com', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' }
  const downstream = deferred<Response>()
  const entered = deferred<void>()
  const apiPending = middleware({
    request: new Request('https://app.example.com/api/drive/entries', { headers: { Cookie: 'linger_session=a', 'X-Linger-Account': 'sub:account-a' } }),
    env, data: {},
    next: () => { entered.resolve(); return downstream.promise },
  } as never)
  await entered.promise
  const response = await logout({
    request: new Request('https://app.example.com/auth/logout', {
      method: 'POST', headers: { Cookie: 'linger_session=a', 'X-Linger-Account': 'sub:account-a', Origin: 'https://app.example.com' },
    }), env,
  } as never)
  expect(response.status).toBe(200)
  expect(kv.has('session:a')).toBe(false)
  downstream.resolve(new Response('{}'))
  const lateResponse = await apiPending
  expect(kv.has('session:a')).toBe(false)
  expect(lateResponse.status).toBe(401)
  expect(lateResponse.headers.get('Set-Cookie')).toContain('Max-Age=0')
})

it('discards an old read even when the same account logs back in', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const read = deferred<LoadedDiaryEntry>()
  vi.mocked(api.getEntryByDate).mockReturnValueOnce(read.promise)
  const pending = hook.result.current.getContent(secret.entry.date)
  await act(async () => hook.rerender({ status: 'signedOut', email: 'a@example.com' }))
  await act(async () => hook.rerender({ status: 'signedIn', email: 'a@example.com' }))
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await act(async () => { read.resolve(secret); await pending })
  expect(await pending).toBeNull()
  expect(await getAllCached()).toEqual([])
})

it('does not cache a read that finishes after unmount', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const read = deferred<LoadedDiaryEntry>()
  vi.mocked(api.getEntryByDate).mockReturnValueOnce(read.promise)
  const pending = hook.result.current.getContent(secret.entry.date)
  hook.unmount()
  read.resolve(secret)
  expect(await pending).toBeNull()
  expect(await getAllCached()).toEqual([])
})

it('discards account A initial listing after account B finishes loading', async () => {
  const listing = deferred<typeof secret.meta[]>()
  vi.mocked(api.listEntries).mockReturnValueOnce(listing.promise)
  const hook = diary()
  await waitFor(() => expect(api.listEntries).toHaveBeenCalledOnce())
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await act(async () => { listing.resolve([secret.meta]) })
  expect(hook.result.current.dates).toEqual([])
  expect(await getAllCached()).toEqual([])
})

it.each(['success', 'network failure'] as const)('does not persist a save finishing after logout: %s', async (outcome) => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const write = deferred<typeof secret.meta>()
  vi.mocked(api.saveEntry).mockReturnValueOnce(outcome === 'success' ? write.promise : write.promise.then(() => { throw new TypeError('offline') }))
  let pending!: Promise<LoadedDiaryEntry>
  await act(async () => { pending = hook.result.current.save(secret.entry.date, secret.entry.content, null) })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await act(async () => hook.rerender({ status: 'signedOut', email: 'a@example.com' }))
  await act(async () => { write.resolve(secret.meta); await rejected })
  expect(await getAllCached()).toEqual([])
  expect(await getAllDrafts()).toEqual([])
  expect(localStorage.getItem(`linger_local_entry_${secret.entry.date}`)).toBeNull()
})

it('does not dispatch a queued write after the account changes', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const write = deferred<typeof secret.meta>()
  vi.mocked(api.saveEntry).mockReturnValueOnce(write.promise)
  let first!: Promise<LoadedDiaryEntry>
  let second!: Promise<LoadedDiaryEntry>
  await act(async () => {
    first = hook.result.current.save(secret.entry.date, 'first', null)
    second = hook.result.current.save(secret.entry.date, 'second', null)
  })
  const rejected = Promise.all([first, second].map(pending => expect(pending).rejects.toMatchObject({ name: 'AbortError' })))
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  await act(async () => { write.resolve(secret.meta); await rejected })
  expect(api.saveEntry).toHaveBeenCalledOnce()
})

it('discards changes fetched before logout', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const changes = deferred<Awaited<ReturnType<typeof api.getChanges>>>()
  vi.mocked(api.getChanges).mockReturnValueOnce(changes.promise)
  const pending = hook.result.current.refreshEntries()
  await act(async () => hook.rerender({ status: 'signedOut', email: 'a@example.com' }))
  await act(async () => { changes.resolve({ changes: [{ fileId: secret.meta.id, file: secret.meta, removed: false }], newStartPageToken: '' }); await pending })
  expect(hook.result.current.dates).toEqual([])
  expect(await getAllCached()).toEqual([])
})

it('does not return old search snippets after an account switch', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  vi.mocked(api.getEntryByDate).mockResolvedValueOnce(secret)
  await act(async () => { await hook.result.current.getContent(secret.entry.date) })
  const search = deferred<typeof secret.meta[]>()
  vi.mocked(api.searchEntries).mockReturnValueOnce(search.promise)
  const pending = hook.result.current.search('private')
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  search.resolve([])
  expect((await pending).results).toEqual([])
})

it('does not enqueue an old offline deletion after logout', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  vi.mocked(api.getEntryByDate).mockResolvedValueOnce(secret)
  await act(async () => { await hook.result.current.getContent(secret.entry.date) })
  const deletion = deferred<void>()
  vi.mocked(api.deleteEntry).mockImplementationOnce(async () => { await deletion.promise; throw new TypeError('offline') })
  const pending = hook.result.current.remove(secret.entry.date)
  await act(async () => hook.rerender({ status: 'signedOut', email: 'a@example.com' }))
  await act(async () => { deletion.resolve(); await pending })
  expect(localStorage.getItem('linger_pending_sync_queue')).toBeNull()
})

it('clears a pending expired-session save before a different account signs in', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  vi.mocked(api.saveEntry).mockRejectedValueOnce(new api.TokenExpiredError())
  await act(async () => {
    await expect(hook.result.current.save(secret.entry.date, secret.entry.content, null)).rejects.toBeInstanceOf(api.TokenExpiredError)
  })
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  await expect(hook.result.current.retryPendingSave()).resolves.toBeNull()
  expect(api.saveEntry).toHaveBeenCalledOnce()
})

it('does not replay old drafts while clearing the previous account cache', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await diaryCache.putDraft({ date: secret.entry.date, content: secret.entry.content, baseContent: null, baseVersion: null, savedAt: 1 })
  const clearing = deferred<void>()
  const clear = vi.spyOn(diaryCache, 'clearCache').mockImplementationOnce(() => clearing.promise)
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  expect(clear).toHaveBeenCalledOnce()
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(api.saveEntry).not.toHaveBeenCalled()
  // Complete the pending cache wipe before allowing account B to load.
  await clearCache()
  await act(async () => { clearing.resolve() })
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  expect(api.saveEntry).not.toHaveBeenCalled()
})

it('rejects session data recreated by a stale writer', async () => {
  const kv = createFakeKV()
  const env = { SESSIONS: kv } as never
  await invalidateSession('a', undefined, env)
  await kv.put('session:a', JSON.stringify({ access_token: 'stale' }))
  expect(await getSession('a', env)).toBeNull()
  await expect(saveSession('a', { access_token: 'a', refresh_token: 'r', expires_at: 0 }, env)).rejects.toBeInstanceOf(SessionRevokedError)
  // A new sign-in has a different random session ID and remains usable.
  await saveSession('b', { access_token: 'b', refresh_token: 'r', expires_at: 0 }, env)
  expect((await getSession('b', env))?.access_token).toBe('b')
})

it('keeps authorization revoked when the token-record deletion fails', async () => {
  const kv = createFakeKV({ 'session:a': JSON.stringify({ access_token: 'a' }) })
  const env = { SESSIONS: { ...kv, delete: async () => { throw new Error('KV delete unavailable') } } } as never
  await expect(invalidateSession('a', undefined, env)).rejects.toThrow('KV delete unavailable')
  expect(kv.has('session:a')).toBe(true)
  expect(await getSession('a', env)).toBeNull()
})

it('rejects a token refresh completing after logout', async () => {
  const session = { access_token: 'a', refresh_token: 'r', expires_at: 0 }
  const kv = createFakeKV({ 'session:a': JSON.stringify(session) })
  const env = { SESSIONS: kv, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' } as never
  const refreshed = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(refreshed.promise))
  const pending = getValidAccessToken('a', session, env)
  const rejected = expect(pending).rejects.toBeInstanceOf(SessionRevokedError)
  await invalidateSession('a', undefined, env)
  refreshed.resolve(new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 })))
  await rejected
  expect(await getSession('a', env)).toBeNull()
  expect(kv.has('session:a')).toBe(false)
})

it('rejects revocation that races with an already-started KV write', async () => {
  const kv = createFakeKV()
  const write = deferred<void>()
  const entered = deferred<void>()
  const env = { SESSIONS: { ...kv, put: async (key: string, value: string) => {
    if (key === 'session:a') { entered.resolve(); await write.promise }
    await kv.put(key, value)
  } } } as never
  const pending = saveSession('a', { access_token: 'a', refresh_token: 'r', expires_at: 0 }, env)
  const rejected = expect(pending).rejects.toBeInstanceOf(SessionRevokedError)
  await entered.promise
  await invalidateSession('a', undefined, env)
  write.resolve()
  await rejected
  expect(kv.has('session:a')).toBe(false)
  expect(await getSession('a', env)).toBeNull()
})
