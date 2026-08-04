import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  parseSessionId, getSession, saveSession, getValidAccessToken, getValidIdToken,
  makeSessionCookie, clearSessionCookie, jsonResponse,
  addEmailSessionIndex, removeEmailSessionIndex, deleteAllSessionsForEmail,
  getRefreshTokenForEmail, invalidateSession,
  RefreshTokenInvalidError,
  SESSION_TTL,
} from '../../functions/_shared/session'

describe('jsonResponse', () => {
  it('marks JSON responses as non-cacheable with security headers', () => {
    const response = jsonResponse({ ok: true })

    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('parseSessionId', () => {
  function mockRequest(cookie?: string): Request {
    return new Request('http://localhost', {
      headers: cookie ? { Cookie: cookie } : {},
    })
  }

  it('extracts session cookie from Cookie header', () => {
    expect(parseSessionId(mockRequest('linger_session=abc123; other=val'))).toBe('abc123')
  })

  it('returns null when no Cookie header', () => {
    expect(parseSessionId(mockRequest())).toBeNull()
  })

  it('returns null when session cookie value is empty', () => {
    expect(parseSessionId(mockRequest('linger_session=; other=val'))).toBeNull()
  })

  it('returns null when session cookie is absent', () => {
    expect(parseSessionId(mockRequest('other=val'))).toBeNull()
  })

  it('decodes URI-encoded session ID', () => {
    expect(parseSessionId(mockRequest('linger_session=hello%20world'))).toBe('hello world')
  })
})

describe('getSession', () => {
  it('returns parsed session when KV has a value', async () => {
    const sessionData = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(sessionData)) } }
    expect(await getSession('sid', env as any)).toEqual(sessionData)
  })

  it('returns null when KV returns null', async () => {
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null) } }
    expect(await getSession('sid', env as any)).toBeNull()
  })

  it('returns null when stored JSON is invalid', async () => {
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue('not-json') } }
    expect(await getSession('sid', env as any)).toBeNull()
  })
})

describe('saveSession', () => {
  it('writes session JSON to KV with 30-day TTL', async () => {
    const put = vi.fn()
    const env = { SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }
    await saveSession('sid', session, env as any)
    expect(put).toHaveBeenCalledWith('session:sid', JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 })
  })
})

describe('makeSessionCookie', () => {
  it('creates a secure HttpOnly session cookie', () => {
    const cookie = makeSessionCookie('abc123', 3600, true)
    expect(cookie).toContain('linger_session=abc123')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=3600')
  })

  it('omits Secure flag when secure=false', () => {
    expect(makeSessionCookie('abc123', 3600, false)).not.toContain('Secure')
  })

  it('encodes the session ID', () => {
    expect(makeSessionCookie('a b', 3600)).toContain('linger_session=a%20b')
  })
})

describe('clearSessionCookie', () => {
  it('creates a cookie with Max-Age=0', () => {
    const cookie = clearSessionCookie(true)
    expect(cookie).toContain('linger_session=')
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('Secure')
  })

  it('omits Secure flag when secure=false', () => {
    expect(clearSessionCookie(false)).not.toContain('Secure')
  })
})

describe('getValidAccessToken', () => {
  const baseEnv = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function fakeKvEnv(store: Map<string, string>) {
    return {
      ...baseEnv,
      SESSIONS: {
        get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
        put: vi.fn((key: string, value: string) => { store.set(key, value) }),
      },
    }
  }

  function okRefreshResponse() {
    return new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('coalesces concurrent refreshes of the same session into a single Google call', async () => {
    // Regression guard: on app load, several API requests fire in parallel. If they
    // each refreshed independently (see getValidSession's inFlightRefreshes dedupe)
    // a single expired token would stampede Google's token endpoint with the same
    // refresh_token — inflating the odds of a 429 or a transient failure surfacing
    // as a spurious session-expired flow.
    const fetchSpy = vi.fn().mockResolvedValue(okRefreshResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const store = new Map<string, string>()
    const env = fakeKvEnv(store)
    const sessionA = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }
    const sessionB = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const [tokenA, tokenB] = await Promise.all([
      getValidAccessToken('sid', sessionA, env as any),
      getValidAccessToken('sid', sessionB, env as any),
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(tokenA).toBe('new_at')
    expect(tokenB).toBe('new_at')
    // The waiter adopted the shared refresh's persisted tokens (the in-place
    // mutation invariant holds for it too, not just for the refreshing caller).
    expect(sessionB.access_token).toBe('new_at')
  })

  it('still refreshes each session independently when they differ', async () => {
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(okRefreshResponse()))
    vi.stubGlobal('fetch', fetchSpy)
    const store = new Map<string, string>()
    const env = fakeKvEnv(store)
    const sessionA = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }
    const sessionB = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    await Promise.all([
      getValidAccessToken('sid-a', sessionA, env as any),
      getValidAccessToken('sid-b', sessionB, env as any),
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('rethrows a failed shared refresh to concurrent waiters instead of handing back an expired token', async () => {
    // A waiter must not proceed on a stale (still-expired) access token after the
    // shared refresh failed — it would 401 against Drive and re-trigger the
    // session-expired flow for a session that is merely going through a blip.
    const fetchSpy = vi.fn().mockResolvedValue(new Response('Server Error', { status: 503 }))
    vi.stubGlobal('fetch', fetchSpy)
    const env = fakeKvEnv(new Map())
    const sessionA = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }
    const sessionB = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const promiseA = getValidAccessToken('sid', sessionA, env as any)
    const promiseB = getValidAccessToken('sid', sessionB, env as any)
    // Attach both rejection assertions before advancing fake timers (see the
    // transient-failure test above for why ordering matters here).
    const assertA = expect(promiseA).rejects.toThrow('Token refresh failed: 503')
    const assertB = expect(promiseB).rejects.toThrow('Token refresh failed: 503')
    await vi.runAllTimersAsync()
    await Promise.all([assertA, assertB])
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('returns current access token when not expired', async () => {
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 120_000 }
    const result = await getValidAccessToken('sid', session, baseEnv as any)
    expect(result).toBe('at')
  })

  it('does not write to KV when token is still valid', async () => {
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 120_000 }

    await getValidAccessToken('sid', session, env as any)

    expect(put).not.toHaveBeenCalled()
  })

  it('refreshes token when expired and stores the new token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const result = await getValidAccessToken('sid', session, env as any)

    expect(result).toBe('new_at')
    expect(put).toHaveBeenCalledOnce()
    const stored = JSON.parse(put.mock.calls[0][1])
    expect(stored.access_token).toBe('new_at')
    expect(stored.refresh_token).toBe('rt')
    expect(stored.client_id).toBe('id')
  })

  it('throws a generic error (not RefreshTokenInvalidError) after retries are exhausted on a transient failure', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('Server Error', { status: 503 }))
    vi.stubGlobal('fetch', fetchSpy)
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const promise = getValidAccessToken('sid', session, baseEnv as any)
    // Attach the rejection assertion before letting fake timers advance — awaiting
    // runAllTimersAsync() first would let the promise reject with no handler attached
    // yet, which Node flags as an unhandled rejection even though it's handled a tick
    // later (surfaces as a Vitest "Unhandled Errors" failure despite the test passing).
    const assertion = expect(promise).rejects.toThrow('Token refresh failed: 503')
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('does not treat a 400 invalid_grant as transient — no retries', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    )
    vi.stubGlobal('fetch', fetchSpy)
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    await expect(getValidAccessToken('sid', session, baseEnv as any)).rejects.toBeInstanceOf(RefreshTokenInvalidError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('recovers from a transient failure that succeeds on retry, instead of forcing re-login', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response('Server Error', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchSpy)
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const promise = getValidAccessToken('sid', session, env as any)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe('new_at')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries a network-level fetch failure (not just a bad status)', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchSpy)
    const env = { ...baseEnv, SESSIONS: { put: vi.fn() } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const promise = getValidAccessToken('sid', session, env as any)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe('new_at')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('throws RefreshTokenInvalidError on a dead refresh_token (400 invalid_grant)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    ))
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    await expect(getValidAccessToken('sid', session, baseEnv as any)).rejects.toBeInstanceOf(RefreshTokenInvalidError)
  })
})

describe('getValidIdToken', () => {
  const baseEnv = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns the current id_token when the session is not expired', async () => {
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 120_000, id_token: 'idtok' }
    expect(await getValidIdToken('sid', session, baseEnv as any)).toBe('idtok')
  })

  it('carries the new id_token forward when refresh returns one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600, id_token: 'new_idtok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000, id_token: 'old_idtok' }

    expect(await getValidIdToken('sid', session, env as any)).toBe('new_idtok')
    const stored = JSON.parse(put.mock.calls[0][1])
    expect(stored.id_token).toBe('new_idtok')
  })

  it('forces a refresh when id_token is missing even though the access token is not yet expired', async () => {
    // A previous refresh can drop id_token (see below) without expires_at being anywhere
    // near expiry — without forcing a refresh here, id_token would stay missing, and
    // every S3 mirror attempt would keep failing, for up to ~1hr until expires_at forces
    // the normal refresh path anyway.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600, id_token: 'recovered_idtok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'still_valid_at', expires_at: Date.now() + 120_000 }

    expect(await getValidIdToken('sid', session, env as any)).toBe('recovered_idtok')
    expect(put).toHaveBeenCalledOnce()
    const stored = JSON.parse(put.mock.calls[0][1])
    expect(stored.id_token).toBe('recovered_idtok')
    expect(stored.access_token).toBe('new_at')
  })

  it('does not force a refresh for getValidAccessToken just because id_token is absent', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const session = { refresh_token: 'rt', access_token: 'still_valid_at', expires_at: Date.now() + 120_000 }

    const result = await getValidAccessToken('sid', session, baseEnv as any)

    expect(result).toBe('still_valid_at')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('drops a stale id_token instead of keeping it when refresh omits a new one', async () => {
    // The id_token shares the access_token's expiry, so a kept-but-not-reissued
    // id_token is expired by definition — every subsequent STS AssumeRoleWithWebIdentity
    // call for self-hosted S3 mirroring would fail silently forever. Dropping it makes
    // getValidIdToken honestly return null instead of handing out dead credentials.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000, id_token: 'old_idtok' }

    expect(await getValidIdToken('sid', session, env as any)).toBeNull()
    const stored = JSON.parse(put.mock.calls[0][1])
    expect(stored.id_token).toBeUndefined()
  })

  // Regression guard: getValidSession/getValidIdToken/getValidAccessToken used to
  // return a *new* object on refresh instead of mutating the caller's `session` in
  // place. Any caller that kept using its own `session` variable after the call (e.g.
  // s3Settings.ts's mirrorEntrySave, which reads `session` again for
  // assumeRoleWithWebIdentity/credentialsCacheKey, or would save it again itself for a
  // future credentials cache) would silently keep seeing pre-refresh values — and if
  // anything downstream ever called saveSession(session) again, it would clobber the
  // fresh tokens this function had just persisted with the stale ones it started with.
  it('mutates the caller-provided session object in place, not just KV, so later readers of the same reference see the refreshed tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600, id_token: 'new_idtok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const env = { ...baseEnv, SESSIONS: { put: vi.fn() } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000, id_token: 'old_idtok' }

    await getValidIdToken('sid', session, env as any)

    expect(session.access_token).toBe('new_at')
    expect(session.id_token).toBe('new_idtok')
  })

  it('a later saveSession of the same object cannot clobber the refresh with stale data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600, id_token: 'new_idtok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const store = new Map<string, string>()
    const env = { ...baseEnv, SESSIONS: { put: vi.fn((key: string, value: string) => { store.set(key, value) }) } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000, id_token: 'old_idtok' }

    await getValidIdToken('sid', session, env as any)
    // Some other code, further down the same call stack, saves the same `session`
    // reference again for an unrelated reason (e.g. caching something else onto it).
    await saveSession('sid', session, env as any)

    const stored = JSON.parse(store.get('session:sid')!)
    expect(stored.access_token).toBe('new_at')
    expect(stored.id_token).toBe('new_idtok')
  })
})

describe('addEmailSessionIndex', () => {
  // Each session gets its own KV key under an email-prefixed namespace, instead
  // of one aggregate key holding a JSON array — so this is a single put with no
  // preceding read, and thus no read-modify-write race between two concurrent
  // sign-ins for the same email (see git history: the old aggregate-array design
  // could silently drop a concurrent sign-in's session ID from the index).
  it('writes an index entry keyed by session ID under the email prefix, with the session TTL, without reading first', async () => {
    const get = vi.fn()
    const put = vi.fn()
    const env = { SESSIONS: { get, put } }
    await addEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(get).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalledWith('esidx:user@example.com:sid1', '', { expirationTtl: SESSION_TTL })
  })

  it('normalizes email before writing the key', async () => {
    const put = vi.fn()
    const env = { SESSIONS: { put } }
    await addEmailSessionIndex('User@Example.COM', 'sid1', env as any)
    expect(put).toHaveBeenCalledWith('esidx:user@example.com:sid1', '', { expirationTtl: SESSION_TTL })
  })

  it('is idempotent — calling it again for the same session (e.g. to renew TTL) just re-writes the same key', async () => {
    const put = vi.fn()
    const env = { SESSIONS: { put } }
    await addEmailSessionIndex('user@example.com', 'sid1', env as any)
    await addEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(put).toHaveBeenCalledTimes(2)
    expect(put).toHaveBeenNthCalledWith(1, 'esidx:user@example.com:sid1', '', { expirationTtl: SESSION_TTL })
    expect(put).toHaveBeenNthCalledWith(2, 'esidx:user@example.com:sid1', '', { expirationTtl: SESSION_TTL })
  })
})

describe('getRefreshTokenForEmail', () => {
  it('returns null when no sessions are indexed for the email', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [], list_complete: true })
    const env = { SESSIONS: { list } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBeNull()
    expect(list).toHaveBeenCalledWith({ prefix: 'esidx:user@example.com:' })
  })

  it('returns the refresh_token from the first session matching the current client', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:sid1' }], list_complete: true })
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ refresh_token: 'rt1', access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { list, get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt1')
  })

  it('skips sessions without a refresh_token and returns the first one that has it', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:sid1' }, { name: 'esidx:user@example.com:sid2' }], list_complete: true })
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      if (key === 'session:sid2') return Promise.resolve(JSON.stringify({ refresh_token: 'rt2', access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { list, get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt2')
  })

  it('returns null when all indexed sessions have no refresh_token', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:sid1' }], list_complete: true })
    const get = vi.fn().mockResolvedValue(JSON.stringify({ access_token: 'at', expires_at: 0, client_id: 'client-a' }))
    const env = { SESSIONS: { list, get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBeNull()
  })

  it('skips a refresh_token minted by a different (e.g. retired Blue/Green) client', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:sid1' }, { name: 'esidx:user@example.com:sid2' }], list_complete: true })
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ refresh_token: 'rt-old', access_token: 'at', expires_at: 0, client_id: 'client-old' }))
      if (key === 'session:sid2') return Promise.resolve(JSON.stringify({ refresh_token: 'rt-current', access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { list, get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt-current')
  })

  it('returns null when the only matching session predates client_id tracking', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:sid1' }], list_complete: true })
    const get = vi.fn().mockResolvedValue(JSON.stringify({ refresh_token: 'rt1', access_token: 'at', expires_at: 0 }))
    const env = { SESSIONS: { list, get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBeNull()
  })

  it('normalizes email (uppercase) before listing the index', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [], list_complete: true })
    const env = { SESSIONS: { list } }
    await getRefreshTokenForEmail('User@Example.COM', 'client-a', env as any)
    expect(list).toHaveBeenCalledWith({ prefix: 'esidx:user@example.com:' })
  })

  it('follows the cursor across multiple pages of indexed sessions', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ keys: [{ name: 'esidx:user@example.com:sid1' }], list_complete: false, cursor: 'c1' })
      .mockResolvedValueOnce({ keys: [{ name: 'esidx:user@example.com:sid2' }], list_complete: true })
    const get = vi.fn().mockImplementation((key: string) =>
      key === 'session:sid2' ? Promise.resolve(JSON.stringify({ refresh_token: 'rt2', access_token: 'at', expires_at: 0, client_id: 'client-a' })) : Promise.resolve(null)
    )
    const env = { SESSIONS: { list, get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt2')
    expect(list).toHaveBeenNthCalledWith(1, { prefix: 'esidx:user@example.com:', cursor: undefined })
    expect(list).toHaveBeenNthCalledWith(2, { prefix: 'esidx:user@example.com:', cursor: 'c1' })
  })
})

describe('invalidateSession', () => {
  // Deletes the session record *first*: if only one of the two deletes can land,
  // a dangling index entry (harmless — getSession returns null for it and every
  // caller already skips null sessions) is far preferable to a live session left
  // silently unreachable via the email index.
  it('deletes the session record before removing the email index entry', async () => {
    const del = vi.fn()
    const env = { SESSIONS: { delete: del } }
    await invalidateSession('sid1', 'user@example.com', env as any)
    expect(del).toHaveBeenNthCalledWith(1, 'session:sid1')
    expect(del).toHaveBeenNthCalledWith(2, 'esidx:user@example.com:sid1')
  })

  it('deletes the session record without touching the index when email is unknown', async () => {
    const del = vi.fn()
    const env = { SESSIONS: { delete: del } }
    await invalidateSession('sid1', undefined, env as any)
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('session:sid1')
  })
})

describe('removeEmailSessionIndex', () => {
  it('deletes the index entry for that one session, without reading or touching any other session', async () => {
    const get = vi.fn()
    const del = vi.fn()
    const env = { SESSIONS: { get, delete: del } }
    await removeEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(get).not.toHaveBeenCalled()
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('esidx:user@example.com:sid1')
  })

  it('normalizes email before deleting the key', async () => {
    const del = vi.fn()
    const env = { SESSIONS: { delete: del } }
    await removeEmailSessionIndex('User@Example.COM', 'sid1', env as any)
    expect(del).toHaveBeenCalledWith('esidx:user@example.com:sid1')
  })
})

describe('deleteAllSessionsForEmail', () => {
  it('deletes every indexed session record and its own index entry', async () => {
    const list = vi.fn().mockResolvedValue({
      keys: [{ name: 'esidx:user@example.com:sid1' }, { name: 'esidx:user@example.com:sid2' }],
      list_complete: true,
    })
    const del = vi.fn().mockResolvedValue(undefined)
    const env = { SESSIONS: { list, delete: del } }
    await deleteAllSessionsForEmail('user@example.com', env as any)
    expect(del).toHaveBeenCalledWith('session:sid1')
    expect(del).toHaveBeenCalledWith('session:sid2')
    expect(del).toHaveBeenCalledWith('esidx:user@example.com:sid1')
    expect(del).toHaveBeenCalledWith('esidx:user@example.com:sid2')
  })

  it('normalizes email (uppercase) before listing the index', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [], list_complete: true })
    const env = { SESSIONS: { list, delete: vi.fn() } }
    await deleteAllSessionsForEmail('User@Example.COM', env as any)
    expect(list).toHaveBeenCalledWith({ prefix: 'esidx:user@example.com:' })
  })

  it('still deletes the other indexed sessions when one session record fails to delete', async () => {
    // Regression guard: each session's index entry is independent (see
    // addEmailSessionIndex), so one KV failure must not abort or corrupt the
    // others — unlike the old shared-array design, there is no combined state
    // to "keep the failed ones in" any more; a session that fails to delete
    // here simply lingers until its own pre-existing TTL, same residual risk
    // as before.
    const list = vi.fn().mockResolvedValue({
      keys: [{ name: 'esidx:user@example.com:sid1' }, { name: 'esidx:user@example.com:sid2' }],
      list_complete: true,
    })
    const del = vi.fn().mockImplementation((key: string) =>
      key === 'session:sid1' ? Promise.reject(new Error('KV error')) : Promise.resolve(undefined)
    )
    const env = { SESSIONS: { list, delete: del } }
    await deleteAllSessionsForEmail('user@example.com', env as any)
    expect(del).toHaveBeenCalledWith('session:sid2')
    expect(del).toHaveBeenCalledWith('esidx:user@example.com:sid2')
  })

  it('does nothing when no sessions are indexed', async () => {
    const list = vi.fn().mockResolvedValue({ keys: [], list_complete: true })
    const del = vi.fn()
    const env = { SESSIONS: { list, delete: del } }
    await deleteAllSessionsForEmail('user@example.com', env as any)
    expect(del).not.toHaveBeenCalled()
  })
})
