import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPost } from '../../functions/auth/login'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'

async function fixture() { return createPasskeyTestEnv({}, { domain: 'https://example.com' }) }
function loginRequest(path = '/auth/login', sessionId = 'sid123') {
  return new Request(`https://example.com${path}`, { headers: { Cookie: `linger_session=${sessionId}` } })
}

describe('OAuth login popup redirect', () => {
  it('starts an offline authorization code flow for an authenticated passkey session', async () => {
    const { env, db, sessionId, userId } = await fixture()
    const response = await onRequestGet({ env, request: loginRequest('/auth/login', sessionId) } as never)
    const url = new URL(response.headers.get('Location')!)
    expect(response.status).toBe(302)
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.pathname).toBe('/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/auth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'https://www.googleapis.com/auth/drive.file', 'openid'])
    expect(url.searchParams.get('include_granted_scopes')).toBe('false')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const state = url.searchParams.get('state')!
    const stateRow = db.prepare('SELECT data FROM auth_oauth_states WHERE id = ?').get(state) as { data: string }
    expect(JSON.parse(stateRow.data)).toMatchObject({ userId, sessionHandle: expect.stringMatching(/^sha256:/), popup: true })
    expect(stateRow.data).not.toContain('access_token')
    expect(stateRow.data).not.toContain('google_sub')
    expect(response.headers.get('Set-Cookie')).toContain(`linger_oauth_state_${state}=`)
    expect(response.headers.get('Set-Cookie')).toContain(`linger_oauth_pkce_${state}=`)
    expect(response.headers.get('Set-Cookie')).toContain('SameSite=Lax')
    db.close()
  })

  it('forces account selection only when explicitly requested', async () => {
    const { env, db, sessionId } = await fixture()
    const response = await onRequestGet({ env, request: loginRequest('/auth/login?select_account=1&reuse=1', sessionId) } as never)
    expect(new URL(response.headers.get('Location')!).searchParams.get('prompt')).toBe('select_account')
    db.close()
  })

  it('does not force consent or account selection when reusing a working credential', async () => {
    const { env, db, sessionId } = await fixture()
    const response = await onRequestGet({ env, request: loginRequest('/auth/login?reuse=1', sessionId) } as never)
    expect(new URL(response.headers.get('Location')!).searchParams.get('prompt')).toBeNull()
    db.close()
  })

  it('requests consent when recovering an offline credential', async () => {
    const { env, db, sessionId } = await fixture()
    const response = await onRequestGet({ env, request: loginRequest('/auth/login?select_account=1', sessionId) } as never)
    expect(new URL(response.headers.get('Location')!).searchParams.get('prompt')).toBe('select_account consent')
    db.close()
  })

  it('rejects login without a passkey session and does not store OAuth state', async () => {
    const { env, db } = await fixture()
    const response = await onRequestGet({ env, request: loginRequest('/auth/login', 'missing-session') } as never)
    expect(response.status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS count FROM auth_oauth_states').get()).toEqual({ count: 0 })
    db.close()
  })

  it('allows Google authorization before passkey creation only in setup mode', async () => {
    const { env, db } = await fixture()
    const response = await onRequestGet({ env, request: loginRequest('/auth/login?setup=1', 'missing-session') } as never)
    expect(response.status).toBe(302)
    const state = new URL(response.headers.get('Location')!).searchParams.get('state')!
    expect(new URL(response.headers.get('Location')!).searchParams.get('prompt')).toBe('consent')
    const row = db.prepare('SELECT data FROM auth_oauth_states WHERE id = ?').get(state) as { data: string }
    expect(JSON.parse(row.data)).toMatchObject({ setup: true, popup: true, nonce: expect.any(String) })
    expect(row.data).not.toContain('refresh_token')
    db.close()
  })

  it('does not scan or write session storage while starting OAuth', async () => {
    const { env, db, sessionId, kv } = await fixture()
    await onRequestGet({ env, request: loginRequest('/auth/login', sessionId) } as never)
    expect(kv.size()).toBe(0)
    db.close()
  })

  it('rejects POST instead of accepting a credential-bearing login request', async () => {
    const response = await onRequestPost({} as never)
    expect(response.status).toBe(405)
  })
})
