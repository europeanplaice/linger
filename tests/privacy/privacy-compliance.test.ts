import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { legacyAuthEnabled, sanitizeSession } from '../../functions/_shared/authStore'
import { createSession, getSession } from '../../functions/_shared/session'
import { clearOAuthCredentials, getAccessToken, getIdToken, setOAuthCredentials } from '../../src/lib/oauthCredentials'
import { apiFetch, searchEntries } from '../../src/api/driveEntries'
import { jsonResponse } from '../../functions/_shared/session'
import { describeError, S3Error } from '../../functions/_shared/s3'
import { revokeSession, startSignIn } from '../../src/api/auth'

const accessToken = 'sentinel-google-access-token'
const refreshToken = 'sentinel-google-refresh-token'
const idToken = 'sentinel-google-id-token'
const awsSecret = 'sentinel-aws-secret-key'
const diaryText = 'sentinel-private-diary-text'

describe('diagnostic privacy boundary', () => {
  it('does not persist arbitrary provider errors or error names in status summaries', () => {
    const error = new Error(`${accessToken} ${diaryText}`)
    error.name = `${awsSecret} ${diaryText}`
    expect(describeError(error)).toBe('Error occurred')
    expect(describeError(new S3Error(403, `${idToken} ${diaryText}`))).toBe('Request failed (HTTP 403)')
  })

  it('allows only fixed string literals in backend console calls', () => {
    function files(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
      })
    }
    const violations: string[] = []
    for (const file of [...files('functions'), ...files('workers/s3-workflows/src')]) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console' &&
          node.arguments.some(arg => !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source))
          violations.push(`${file}:${position.line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })
})

describe('OAuth persistence boundary', () => {
  it('projects session values through an explicit metadata allowlist', () => {
    expect(sanitizeSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      expires_at: Date.now() + 60_000,
      s3_assumed_credentials: { secretAccessKey: awsSecret },
      diary_content: diaryText,
      folder_id: 'folder-123',
      email: 'user@example.com',
      google_sub: 'google-sub-123',
      unrecognized_future_field: { token: 'future-secret' },
    } as never)).toEqual({
      folder_id: 'folder-123',
      email: 'user@example.com',
      google_sub: 'google-sub-123',
    })
  })

  it('writes only metadata to KV even when callers pass credentials', async () => {
    const stored = new Map<string, string>()
    const env = {
      SESSIONS: {
        put: vi.fn(async (key: string, value: string) => { stored.set(key, value) }),
        get: vi.fn(async (key: string) => stored.get(key) ?? null),
      },
    } as never

    await createSession('session-1', {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      expires_at: Date.now() + 60_000,
      s3_assumed_credentials: { secretAccessKey: awsSecret },
      email: 'user@example.com',
    } as never, env)

    const serialized = stored.get('session:session-1') ?? ''
    expect(serialized).toContain('user@example.com')
    expect(serialized).not.toContain(accessToken)
    expect(serialized).not.toContain(refreshToken)
    expect(serialized).not.toContain(idToken)
    expect(serialized).not.toContain(awsSecret)
  })

  it('never imports legacy KV sessions after the cutover', async () => {
    const first = vi.fn().mockResolvedValue(null)
    const get = vi.fn().mockResolvedValue(JSON.stringify({ access_token: accessToken }))
    const env = {
      AUTH_KV_FALLBACK_UNTIL: '2099-01-01T00:00:00Z',
      AUTH_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) },
      SESSIONS: { get, list: vi.fn() },
    } as never

    expect(legacyAuthEnabled(env)).toBe(false)
    expect(await getSession('legacy-session', env)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('D1 privacy migration', () => {
  function migratedDatabase(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(readFileSync('migrations/auth/0001_auth.sql', 'utf8'))
    db.prepare(`INSERT INTO auth_sessions (id, data, email, google_sub, client_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('legacy', JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, id_token: idToken, aws_secret: awsSecret }), 'user@example.com', 'sub-1', 'client-1', Date.now() + 60_000)
    db.exec(readFileSync('migrations/auth/0002_memory_only_oauth.sql', 'utf8'))
    return db
  }

  it('scrubs pre-existing credential payloads and revokes the old session', () => {
    const db = migratedDatabase()
    const row = db.prepare('SELECT data, revoked FROM auth_sessions WHERE id = ?').get('legacy') as { data: string | null; revoked: number }
    expect(row).toEqual({ data: null, revoked: 1 })
    db.close()
  })

  it('rejects credentials, unknown keys, and nested secret objects on insert and update', () => {
    const db = migratedDatabase()
    const insert = db.prepare('INSERT INTO auth_sessions (id, data, expires_at) VALUES (?, ?, ?)')
    for (const payload of [
      { access_token: accessToken },
      { future_credential: 'sentinel' },
      { folder_id: { access_token: accessToken } },
      [{ email: 'user@example.com' }],
    ]) {
      expect(() => insert.run(crypto.randomUUID(), JSON.stringify(payload), Date.now() + 60_000)).toThrow()
    }
    const update = db.prepare('UPDATE auth_sessions SET data = ? WHERE id = ?')
    expect(() => update.run(JSON.stringify({ refresh_token: refreshToken }), 'legacy')).toThrow()
    db.close()
  })

  it('accepts the current scalar metadata shape', () => {
    const db = migratedDatabase()
    db.prepare('INSERT INTO auth_sessions (id, data, expires_at) VALUES (?, ?, ?)')
      .run('metadata', JSON.stringify({ folder_id: 'folder-1', email: 'user@example.com', google_sub: 'sub-1', renewed_at: Date.now() }), Date.now() + 60_000)
    expect(db.prepare('SELECT data FROM auth_sessions WHERE id = ?').get('metadata')).toBeTruthy()
    db.close()
  })
})

describe('browser credential lifetime', () => {
  beforeEach(() => {
    clearOAuthCredentials()
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => {
    clearOAuthCredentials()
    vi.restoreAllMocks()
  })

  it('keeps credentials in module memory and clears them on reload-equivalent reset', () => {
    setOAuthCredentials({ accessToken, idToken, expiresAt: Date.now() + 60_000 })
    expect(getAccessToken()).toBe(accessToken)
    expect(getIdToken()).toBe(idToken)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    clearOAuthCredentials()
    expect(getAccessToken()).toBeNull()
    expect(getIdToken()).toBeNull()
  })

  it('does not send credentials to external or non-API URLs', async () => {
    setOAuthCredentials({ accessToken, idToken, expiresAt: Date.now() + 60_000 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    await expect(apiFetch('https://attacker.example/collect')).rejects.toThrow(/Authenticated API requests/)
    await expect(apiFetch('//attacker.example/collect')).rejects.toThrow(/Authenticated API requests/)
    await expect(apiFetch('/not-api')).rejects.toThrow(/Authenticated API requests/)
    expect(fetchSpy).not.toHaveBeenCalled()
    await apiFetch('/api/drive/entries')
    expect(fetchSpy).toHaveBeenCalledWith('/api/drive/entries', expect.objectContaining({
      redirect: 'error',
      headers: expect.any(Headers),
    }))
    expect((fetchSpy.mock.calls[0][1]?.headers as Headers).get('Authorization')).toBe(`Bearer ${accessToken}`)
    fetchSpy.mockRestore()
  })

  it('keeps diary search terms out of the request URL and forbids API response caching', async () => {
    setOAuthCredentials({ accessToken, idToken, expiresAt: Date.now() + 60_000 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"files":[]}'))
    await searchEntries(diaryText)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('/api/drive/search')
    expect(String(url)).not.toContain(diaryText)
    expect(options?.method).toBe('POST')
    expect(JSON.parse(String(options?.body))).toEqual({ query: diaryText })
    expect(jsonResponse({ entry: diaryText }).headers.get('Cache-Control')).toBe('no-store')
  })

  it('accepts popup credentials only from the same-origin popup window', async () => {
    const popup = { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true }) }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ signedIn: true }), { status: 200 }))
    const pending = startSignIn()
    const data = { type: 'linger-oauth-complete', credential: { accessToken, idToken, expiresAt: Date.now() + 60_000 } }

    window.dispatchEvent(new MessageEvent('message', { origin: 'https://attacker.example', source: popup as never, data }))
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: window as never, data }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getAccessToken()).toBeNull()

    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: popup as never, data }))
    await expect(pending).resolves.toMatchObject({ signedIn: true })
    expect(fetchSpy).toHaveBeenCalledWith('/auth/session', expect.objectContaining({
      headers: expect.any(Headers),
      redirect: 'error',
    }))
    expect(getAccessToken()).toBe(accessToken)
    expect(popup.close).toHaveBeenCalledOnce()
    fetchSpy.mockRestore()
  })

  it('keeps a valid popup result while session verification is still pending', async () => {
    let finishVerification!: (response: Response) => void
    const verify = new Promise<Response>(resolve => { finishVerification = resolve })
    const popup = { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true }) }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    vi.spyOn(globalThis, 'fetch').mockReturnValue(verify)
    const pending = startSignIn()
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: popup as never,
      data: { type: 'linger-oauth-complete', credential: { accessToken, idToken, expiresAt: Date.now() + 60_000 } },
    }))
    popup.closed = true
    await new Promise(resolve => setTimeout(resolve, 275))
    finishVerification(new Response(JSON.stringify({ signedIn: true }), { status: 200 }))
    await expect(pending).resolves.toMatchObject({ signedIn: true })
    expect(getAccessToken()).toBe(accessToken)
  })

  it('cancels pending sign-in on logout and ignores a late popup message', async () => {
    const popup = { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true }) }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const pending = startSignIn().catch(error => error)
    await revokeSession()
    await expect(pending).resolves.toBeInstanceOf(Error)
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: popup as never,
      data: { type: 'linger-oauth-complete', credential: { accessToken, idToken, expiresAt: Date.now() + 60_000 } },
    }))
    expect(popup.close).toHaveBeenCalledOnce()
    expect(getAccessToken()).toBeNull()
  })
})
