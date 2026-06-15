import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequestGet, onRequestPost } from '../../functions/auth/login'

beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    getRandomValues: (arr: Uint8Array) => {
      arr.set(Array.from({ length: arr.length }, (_, i) => i + 1))
      return arr
    },
    subtle: {
      digest: async () => {
        const hash = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
        return hash.buffer
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeEnv(domain = 'https://example.com') {
  return {
    SESSIONS: { get: vi.fn(), delete: vi.fn(), put: vi.fn() },
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_DOMAIN: domain,
  }
}

describe('onRequestGet (login redirect)', () => {
  it('redirects to Google OAuth URL with required params', async () => {
    const put = vi.fn()
    const env = makeEnv()
    env.SESSIONS.put = put
    const request = new Request('http://localhost/auth/login')

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(302)
    const url = new URL(response.headers.get('Location')!)
    expect(url.origin).toContain('accounts.google.com')
    expect(url.pathname).toBe('/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/auth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive.file')
    expect(url.searchParams.get('scope')).toContain('email')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBeNull()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
  })

  it('stores code_verifier in KV with state key', async () => {
    const put = vi.fn()
    const env = makeEnv()
    env.SESSIONS.put = put
    const request = new Request('http://localhost/auth/login')

    await onRequestGet({ request, env } as any)

    expect(put).toHaveBeenCalledOnce()
    const [key, verifier, options] = put.mock.calls[0]
    expect(key).toContain('oauth_state:')
    expect(typeof verifier).toBe('string')
    expect(verifier.length).toBeGreaterThan(0)
    expect(options).toEqual({ expirationTtl: 300 })
  })

  it('includes return path in state parameter', async () => {
    const put = vi.fn()
    const env = makeEnv()
    env.SESSIONS.put = put
    const request = new Request('http://localhost/auth/login?redirect=/custom/path')

    const response = await onRequestGet({ request, env } as any)

    const location = response.headers.get('Location')!
    const url = new URL(location)
    const state = url.searchParams.get('state')!
    expect(state).toContain(encodeURIComponent('/custom/path'))
  })

  it('sanitizes protocol-relative redirect path to /', async () => {
    const put = vi.fn()
    const env = makeEnv()
    env.SESSIONS.put = put
    const request = new Request('http://localhost/auth/login?redirect=//evil.com')

    const response = await onRequestGet({ request, env } as any)

    // stateにprotocol-relativeなパスが含まれていないことを確認
    const location = response.headers.get('Location')!
    const url = new URL(location)
    const state = url.searchParams.get('state')!
    const colonIdx = state.indexOf(':')
    const returnPath = colonIdx === -1 ? '/' : decodeURIComponent(state.slice(colonIdx + 1))
    expect(returnPath).toBe('/')
  })

  it('defaults return path to /', async () => {
    const put = vi.fn()
    const env = makeEnv()
    env.SESSIONS.put = put
    const request = new Request('http://localhost/auth/login')

    const response = await onRequestGet({ request, env } as any)

    const location = response.headers.get('Location')!
    const url = new URL(location)
    const state = url.searchParams.get('state')!
    const colonIdx = state.indexOf(':')
    const returnPath = colonIdx === -1 ? '/' : decodeURIComponent(state.slice(colonIdx + 1))
    expect(returnPath).toBe('/')
  })
})

describe('onRequestPost', () => {
  it('returns 405', async () => {
    const response = await onRequestPost({} as any)
    expect(response.status).toBe(405)
    const body = await response.json()
    expect(body).toEqual({ error: 'Method not allowed' })
  })
})
