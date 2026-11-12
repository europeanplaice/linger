import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useDiary } from '../../src/hooks/useDiary'
import * as api from '../../src/api/driveEntries'
import { clearCache, deleteDraft, getAllCached, getAllDrafts } from '../../src/lib/diaryCache'
import * as diaryCache from '../../src/lib/diaryCache'
import { deleteDraft as deleteSecureDraft, getAllDrafts as getSecureDrafts } from '../../src/lib/draftStorage'
import { setActiveAccount } from '../../src/lib/accountSession'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { onRequest as middleware } from '../../functions/api/_middleware'
import { onRequestPost as logout } from '../../functions/auth/logout'
import { sessionStorageId } from '../../functions/_shared/authStore'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
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
  await Promise.all((await getAllDrafts()).map(draft => deleteDraft(draft.date, draft.owner)))
  unlockVaultWithKey('privacy-test-vault', new Uint8Array(32).fill(6))
  setActiveAccount('email:a@example.com', false, 'a@example.com')
  await Promise.all((await getSecureDrafts('a@example.com')).map(draft => deleteSecureDraft(draft.date, 'a@example.com')))
})
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); await clearCache()
  await Promise.all((await getAllDrafts()).map(draft => deleteDraft(draft.date, draft.owner)))
  await Promise.all((await getSecureDrafts('a@example.com')).map(draft => deleteSecureDraft(draft.date, 'a@example.com')))
  setActiveAccount(null)
  clearVaultKey()
  vi.unstubAllGlobals()
})

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
  const { env, db, headers, sessionId, kv } = await createPasskeyTestEnv({ google_sub: 'account-a' }, { sessionId: 'a', clientId: 'c' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    aud: 'c', sub: 'account-a', scope: 'https://www.googleapis.com/auth/drive.file', expires_in: '3600',
  }), { status: 200 })))
  const downstream = deferred<Response>()
  const entered = deferred<void>()
  const apiPending = middleware({
    request: new Request('https://example.com/api/drive/entries', { headers: { ...headers, Authorization: 'Bearer a' } }),
    env, data: {},
    next: () => { entered.resolve(); return downstream.promise },
  } as never)
  await entered.promise
  const response = await logout({
    request: new Request('https://example.com/auth/logout', {
      method: 'POST', headers: { ...headers, Origin: 'https://example.com' },
    }), env,
  } as never)
  expect(response.status).toBe(200)
  expect(kv.has('session:a')).toBe(false)
  downstream.resolve(new Response('{}'))
  const lateResponse = await apiPending
  expect(lateResponse.status).toBe(401)
  expect(lateResponse.headers.get('Set-Cookie')).toContain('Max-Age=0')
  expect(await env.AUTH_DB!.prepare('SELECT user_id, revoked FROM auth_sessions WHERE id = ?').bind(await sessionStorageId(sessionId)).first())
    .toMatchObject({ user_id: null, revoked: 1 })
  db.close()
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

it.each(['success', 'network failure'] as const)('retains an account-scoped draft when a save finishes after logout: %s', async (outcome) => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  const write = deferred<typeof secret.meta>()
  vi.mocked(api.saveEntry).mockReturnValueOnce(outcome === 'success' ? write.promise : write.promise.then(() => { throw new TypeError('offline') }))
  let pending!: Promise<LoadedDiaryEntry>
  await act(async () => { pending = hook.result.current.save(secret.entry.date, secret.entry.content, null) })
  await waitFor(() => expect(api.saveEntry).toHaveBeenCalledOnce())
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await act(async () => hook.rerender({ status: 'signedOut', email: 'a@example.com' }))
  await act(async () => { write.resolve(secret.meta); await rejected })
  expect(await getAllCached()).toEqual([])
  expect(await getSecureDrafts('a@example.com')).toEqual([expect.objectContaining({
    owner: 'a@example.com', date: secret.entry.date, content: secret.entry.content,
  })])
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
  await waitFor(() => expect(api.saveEntry).toHaveBeenCalledOnce())
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

it('does not replay account A drafts for account B when accounts change', async () => {
  const hook = diary()
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await diaryCache.putDraft({ owner: 'a@example.com', date: secret.entry.date, content: secret.entry.content, baseContent: null, baseVersion: null, savedAt: 1 })
  setActiveAccount('email:b@example.com', false, 'b@example.com')
  unlockVaultWithKey('privacy-test-vault-b', new Uint8Array(32).fill(7))
  await act(async () => hook.rerender({ status: 'signedIn', email: 'b@example.com' }))
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve() })
  expect(api.saveEntry).not.toHaveBeenCalled()
  expect(await getAllDrafts('a@example.com')).toHaveLength(1)
  expect(await getAllDrafts('b@example.com')).toEqual([])
  setActiveAccount('email:a@example.com', false, 'a@example.com')
  unlockVaultWithKey('privacy-test-vault', new Uint8Array(32).fill(6))
})

it('rejects session data recreated by a stale writer', async () => {
  const stale = await createPasskeyTestEnv({ google_sub: 'a-sub', folder_id: 'before' }, { sessionId: 'a' })
  const writerSession = (await getSession(stale.sessionId, stale.env, stale.key))!
  writerSession.folder_id = 'late-write'
  await invalidateSession(stale.sessionId, undefined, stale.env)
  await expect(saveSession(stale.sessionId, writerSession, stale.env)).rejects.toBeInstanceOf(SessionRevokedError)
  expect(await getSession(stale.sessionId, stale.env, stale.key)).toBeNull()
  expect(await stale.env.AUTH_DB!.prepare('SELECT user_id, revoked FROM auth_sessions WHERE id = ?')
    .bind(await sessionStorageId(stale.sessionId))
    .first()).toMatchObject({ user_id: null, revoked: 1 })

  const signedIn = await createPasskeyTestEnv({ google_sub: 'b-sub' }, { sessionId: 'b' })
  expect(await getSession(signedIn.sessionId, signedIn.env, signedIn.key)).toMatchObject({ google_sub: 'b-sub', user_id: signedIn.userId })
  stale.db.close()
  signedIn.db.close()
})

it('keeps D1 authorization revoked while the encrypted profile remains', async () => {
  const fixture = await createPasskeyTestEnv({ google_sub: 'revoked-profile-sub' }, { sessionId: 'revoked-profile' })
  const before = await fixture.env.AUTH_DB!.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?')
    .bind(fixture.userId).first<{ account_envelope: string }>()
  await invalidateSession(fixture.sessionId, undefined, fixture.env)
  const row = await fixture.env.AUTH_DB!.prepare('SELECT user_id, revoked FROM auth_sessions WHERE id = ?')
    .bind(await sessionStorageId(fixture.sessionId)).first()
  const after = await fixture.env.AUTH_DB!.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?')
    .bind(fixture.userId).first<{ account_envelope: string }>()
  expect(row).toMatchObject({ user_id: null, revoked: 1 })
  expect(after!.account_envelope).toBe(before!.account_envelope)
  expect(await getSession(fixture.sessionId, fixture.env, fixture.key)).toBeNull()
  fixture.db.close()
})

it('cannot refresh a credential after logout because sessions have no refresh token', async () => {
  const fixture = await createPasskeyTestEnv({ google_sub: 'request-token-sub' }, { sessionId: 'request-token-session' })
  const session = (await getSession(fixture.sessionId, fixture.env, fixture.key))!
  await expect(getValidAccessToken(fixture.sessionId, session, fixture.env)).rejects.toThrow(/request-scoped/)
  expect(await getSession(fixture.sessionId, fixture.env, fixture.key)).not.toHaveProperty('access_token')
  fixture.db.close()
})

it('rejects revocation that races with an already-started encrypted D1 profile update', async () => {
  const fixture = await createPasskeyTestEnv({ google_sub: 'race-sub', folder_id: 'before' }, { sessionId: 'race-session' })
  const write = deferred<void>()
  const entered = deferred<void>()
  const database = fixture.env.AUTH_DB!
  const delayedDb = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql)
        if (!sql.startsWith('UPDATE passkey_users SET account_envelope')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values as never[])
            return {
              first: async (column?: string) => {
                entered.resolve()
                await write.promise
                return column === undefined ? bound.first() : bound.first(column)
              },
            }
          },
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as D1Database
  const raceEnv = { ...fixture.env, AUTH_DB: delayedDb }
  const staleSession = (await getSession(fixture.sessionId, fixture.env, fixture.key))!
  staleSession.folder_id = 'late-write'
  const pending = saveSession(fixture.sessionId, staleSession, raceEnv)
  const rejected = expect(pending).rejects.toBeInstanceOf(SessionRevokedError)
  await entered.promise
  await invalidateSession(fixture.sessionId, undefined, raceEnv)
  write.resolve()
  await rejected
  expect(await getSession(fixture.sessionId, fixture.env, fixture.key)).toBeNull()
  const profile = await fixture.env.AUTH_DB!.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?')
    .bind(fixture.userId).first<{ account_envelope: string }>()
  expect(profile!.account_envelope).not.toContain('late-write')
  fixture.db.close()
})
