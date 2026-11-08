import { expect, test } from '@playwright/test'
import { createPasskeyTestEnv } from './helpers/passkeyAuth'
import type { Env } from '../functions/_shared/session'
import {
  addOptions, addVerify, loginOptions, loginVerify,
  deleteCredential, listCredentials, registrationOptions, registrationVerify,
} from '../functions/_shared/passkeys'

// Native Chrome WebAuthn + real server verification + migrated SQL. Only the
// HTTP transport is intercepted, so mocked signature verification cannot hide
// a mismatch between browser options, PRF bytes, wrappers, and backend handlers.
test('registers, unlocks, adds, and revokes PRF passkeys with real WebAuthn signatures', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator requires CDP')
  const origin = 'http://localhost:5173'
  const { env, db } = await createPasskeyTestEnv({}, { domain: origin })
  const handlers: Record<string, (request: Request, environment: Env) => Promise<Response>> = {
    '/register/options': registrationOptions, '/register/verify': registrationVerify,
    '/login/options': loginOptions, '/login/verify': loginVerify,
    '/add/options': addOptions, '/add/verify': addVerify,
    '/credentials/list': listCredentials, '/credentials/delete': deleteCredential,
  }
  const forbiddenNetworkValues: string[] = []
  const loginVerifyStatuses: number[] = []
  let registrationRequests = 0
  await page.route('**/auth/passkey/**', async route => {
    const incoming = route.request()
    const path = new URL(incoming.url()).pathname.replace('/auth/passkey', '')
    if (path === '/register/options') registrationRequests++
    const handler = handlers[path]
    if (!handler) { await route.fulfill({ status: 404 }); return }
    const body = incoming.postData()
    if (body?.includes('"results"')) forbiddenNetworkValues.push('PRF result sent to server')
    const request = new Request(incoming.url(), {
      method: incoming.method(), headers: await incoming.allHeaders(),
      ...(body ? { body } : {}),
    })
    const response = await handler(request, env)
    if (path === '/login/verify') loginVerifyStatuses.push(response.status)
    for (const cookie of response.headers.getSetCookie()) {
      const fields = cookie.split(';').map(part => part.trim())
      const equals = fields[0].indexOf('=')
      const cookiePath = fields.find(part => part.startsWith('Path='))?.slice(5) ?? '/'
      const maxAge = Number(fields.find(part => part.startsWith('Max-Age='))?.slice(8) ?? 300)
      const cookieData = {
        name: fields[0].slice(0, equals), value: decodeURIComponent(fields[0].slice(equals + 1)),
        domain: 'localhost', path: cookiePath, httpOnly: fields.includes('HttpOnly'), sameSite: 'Strict',
        expires: maxAge === 0 ? 1 : Math.floor(Date.now() / 1000) + maxAge,
      } as const
      await context.addCookies([cookieData])
    }
    const headers = Object.fromEntries(response.headers)
    delete headers['set-cookie']
    await route.fulfill({ status: response.status, headers, body: await response.text() })
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    hasPrf: true,
  } })
  let authenticatorId = authenticator.authenticatorId
  try {
    await page.goto(origin)
    await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in with a saved passkey', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create my first Linger passkey', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'First time using Linger? Get started', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Start using Linger' })).toBeFocused()
    expect(registrationRequests).toBe(0)
    await page.getByRole('button', { name: 'Already have a Linger passkey? Sign in', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toBeFocused()
    await page.getByRole('button', { name: 'First time using Linger? Get started', exact: true }).click()
    await page.getByRole('button', { name: 'Create my first Linger passkey', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible({ timeout: 20_000 })

    const userId = (db.prepare('SELECT user_id AS id FROM passkey_credentials ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(forbiddenNetworkValues).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(userId)).toEqual({ count: 1 })

    await page.evaluate(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create my first Linger passkey', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign in with a saved passkey', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible({ timeout: 20_000 })
    const firstPasskeyKey = await page.evaluate(async internalId => {
      const path = '/src/lib/passkeyVault.ts'
      const key = (await import(/* @vite-ignore */ path)).getVaultKey(internalId) as Uint8Array
      try { return Array.from(key) } finally { key.fill(0) }
    }, userId)
    expect(firstPasskeyKey).toHaveLength(32)
    const originalSessionCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'linger_session')
    expect(originalSessionCookie).toBeTruthy()
    const firstSession = await page.evaluate(async internalId => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).listPasskeys(internalId)
    }, userId)
    const originalCredentialId = firstSession.currentCredentialId
    expect(originalCredentialId).toBeTruthy()
    expect(registrationRequests).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials').get()).toEqual({ count: 1 })
    // A second provider has a different PRF secret. It must wrap the existing
    // master key, rather than silently creating an unreadable new account key.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    const second = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
      hasPrf: true,
    } })
    authenticatorId = second.authenticatorId
    await page.evaluate(async internalId => {
      const path = '/src/api/passkeys.ts'
      await (await import(/* @vite-ignore */ path)).addPasskey(internalId)
    }, userId)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(userId)).toEqual({ count: 2 })

    // Sign in using only the second authenticator. The returned vault key must
    // match the first passkey's in-memory key, proving both wrappers unlock it.
    const secondPasskeyKey = await page.evaluate(async internalId => {
      const vaultPath = '/src/lib/passkeyVault.ts'
      const apiPath = '/src/api/passkeys.ts'
      const vault = await import(/* @vite-ignore */ vaultPath)
      vault.clearVaultKey()
      await (await import(/* @vite-ignore */ apiPath)).loginWithPasskey()
      const key = vault.getVaultKey(internalId) as Uint8Array
      try { return Array.from(key) } finally { key.fill(0) }
    }, userId)
    expect(secondPasskeyKey).toEqual(firstPasskeyKey)
    const listed = await page.evaluate(async internalId => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).listPasskeys(internalId)
    }, userId) as { credentials: Array<{ credentialId: string; createdAt: number }>; currentCredentialId: string | null }
    expect(listed.credentials).toHaveLength(2)
    const removedCredentialId = listed.currentCredentialId
    if (!removedCredentialId) throw new Error('Second passkey sign-in did not identify its credential')
    expect(removedCredentialId).not.toBe(originalCredentialId)
    // Return to the first credential's session while the second authenticator
    // remains installed. Removing the second credential must invalidate that
    // credential's sessions and prevent its next real signed assertion.
    await context.addCookies([originalSessionCookie!])
    await page.evaluate(async ({ internalId, credentialId }) => {
      const path = '/src/api/passkeys.ts'
      await (await import(/* @vite-ignore */ path)).deletePasskey(internalId, credentialId)
    }, { internalId: userId, credentialId: removedCredentialId })
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(userId)).toEqual({ count: 1 })
    const afterDelete = await page.evaluate(async internalId => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).listPasskeys(internalId)
    }, userId) as { credentials: Array<{ credentialId: string; createdAt: number }>; currentCredentialId: string | null }
    expect(afterDelete.credentials.map((entry: { credentialId: string }) => entry.credentialId)).not.toContain(removedCredentialId)

    // Its authenticator still signs a native assertion, but the server no
    // longer accepts that credential after deletion.
    await expect(page.evaluate(async () => {
      const path = '/src/api/passkeys.ts'
      await (await import(/* @vite-ignore */ path)).loginWithPasskey()
    })).rejects.toThrow()
    expect(loginVerifyStatuses.at(-1)).toBe(401)
    const dump = JSON.stringify(db.prepare('SELECT * FROM passkey_users WHERE id = ?').get(userId))
    const keyEncoding = Buffer.from(firstPasskeyKey).toString('base64')
    expect(dump).not.toContain(keyEncoding)
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(JSON.stringify(storage)).not.toContain(keyEncoding)

  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    db.close()
  }
})
