import { expect, test } from '@playwright/test'
import { checkSession, revokeSession } from '../src/api/auth'
import { FetchMock, jsonResponse } from './helpers/mockFetch'

const fetchMock = new FetchMock()

test.beforeEach(() => fetchMock.reset())
test.afterEach(() => fetchMock.restore())

test.describe('checkSession', () => {
  test('returns true when server responds signedIn: true', async () => {
    fetchMock.mock(jsonResponse({ signedIn: true, email: 'user@example.com' }))

    const result = await checkSession()

    expect(result.signedIn).toBe(true)
    expect(result.email).toBe('user@example.com')
    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe('/auth/session')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
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
