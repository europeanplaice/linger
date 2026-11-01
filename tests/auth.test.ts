import { expect, test } from '@playwright/test'
import { checkSession, revokeSession } from '../src/api/auth'
import { clearOAuthCredentials, setOAuthCredentials } from '../src/lib/oauthCredentials'
import { FetchMock, jsonResponse } from './helpers/mockFetch'

const fetchMock = new FetchMock()

test.beforeEach(() => {
  fetchMock.reset()
  setOAuthCredentials({ accessToken: 'test-access-token', idToken: 'test-id-token', expiresAt: Date.now() + 60_000 })
})
test.afterEach(() => {
  clearOAuthCredentials()
  fetchMock.restore()
})

test.describe('checkSession', () => {
  test('returns true when server responds signedIn: true', async () => {
    fetchMock.mock(jsonResponse({ signedIn: true, email: 'user@example.com' }))

    const result = await checkSession()

    expect(result.signedIn).toBe(true)
    expect(result.email).toBe('user@example.com')
    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe('/auth/session')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
    expect(new Headers(fetchMock.calls[0].init?.headers).get('Authorization')).toBe('Bearer test-access-token')
    expect(new Headers(fetchMock.calls[0].init?.headers).get('X-Linger-Google-ID-Token')).toBe('test-id-token')
  })

  test('returns false when server responds signedIn: false', async () => {
    fetchMock.mock(jsonResponse({ signedIn: false, email: null }))

    const result = await checkSession()

    expect(result.signedIn).toBe(false)
    expect(result.email).toBeNull()
  })

  test('returns false when fetch throws', async () => {
    globalThis.fetch = async () => { throw new Error('network error') }

    const result = await checkSession()

    expect(result.signedIn).toBe(false)
    expect(result.email).toBeNull()
  })

  test('does not call the session endpoint after a reload with no memory credentials', async () => {
    clearOAuthCredentials()
    const result = await checkSession()
    expect(result.signedIn).toBe(false)
    expect(fetchMock.calls).toHaveLength(0)
  })
})

test.describe('revokeSession', () => {
  test('sends POST to /auth/logout with credentials', async () => {
    fetchMock.mock(jsonResponse(null, 200))

    await revokeSession()

    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe('/auth/logout')
    expect(fetchMock.calls[0].init?.method).toBe('POST')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
  })
})
