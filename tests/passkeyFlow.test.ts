import { expect, test } from '@playwright/test'
import { createPasskeyTestEnv } from './helpers/passkeyAuth'
import type { Env } from '../functions/_shared/session'
import { onRequestGet as restoreSession } from '../functions/auth/passkey/session'
import {
  addOptions, addVerify, loginOptions, loginVerify,
  deleteCredential, listCredentials, registrationOptions, registrationVerify, renameCredential,
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
    '/credentials/list': listCredentials, '/credentials/delete': deleteCredential, '/credentials/rename': renameCredential,
    '/session': async (request, env) => await restoreSession({ request, env } as Parameters<typeof restoreSession>[0]) as Response,
  }
  const forbiddenNetworkValues: string[] = []
  const loginVerifyStatuses: number[] = []
  let registrationRequests = 0
  let removeCredentialBeforeAdd: { authenticatorId: string; credentialId: string } | null = null
  await page.addInitScript(() => {
    const create = navigator.credentials.create.bind(navigator.credentials)
    navigator.credentials.create = async options => {
      if (options?.publicKey) (window as unknown as { passkeyName?: string }).passkeyName = options.publicKey.user.name
      return create(options)
    }
    // Dismiss the first chooser to reach registration. All subsequent WebAuthn
    // operations use the real virtual authenticator and server verification.
    const get = navigator.credentials.get.bind(navigator.credentials)
    navigator.credentials.get = async options => {
      if (!sessionStorage.getItem('test-passkey-dismissed')) {
        sessionStorage.setItem('test-passkey-dismissed', 'true')
        throw new DOMException('No passkey selected', 'NotAllowedError')
      }
      return get(options)
    }
  })
  await context.route('**/auth/login?*', async route => {
    await route.fulfill({ contentType: 'text/html', body: `<script>window.opener.postMessage({type:'linger-oauth-complete',credential:{accessToken:'test-access',idToken:'test-id',expiresAt:Date.now()+3600000,email:'person@example.com'}}, location.origin)</script>` })
  })
  await context.route('**/auth/passkey/**', async route => {
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
    if (path === '/add/options' && removeCredentialBeforeAdd) {
      await cdp.send('WebAuthn.removeCredential', removeCredentialBeforeAdd)
      removeCredentialBeforeAdd = null
    }
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
  await context.route('**/auth/refresh', route => route.fulfill({ status: 401, json: { error: 'Google authorization required' } }))
  await context.route('**/auth/session', route => route.fulfill({ json: { signedIn: false } }))
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
    await expect(page.getByRole('button', { name: 'Open Linger', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create my first Linger passkey', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open Linger', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Choose how to continue' })).toBeFocused()
    await page.getByRole('button', { name: 'First time using Linger? Get started', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Start using Linger' })).toBeFocused()
    expect(registrationRequests).toBe(0)
    await page.getByRole('button', { name: 'Already have a Linger passkey? Sign in', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Choose how to continue' })).toBeFocused()
    await page.getByRole('button', { name: 'First time using Linger? Get started', exact: true }).click()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click()
    await expect(page.getByText('person@example.com', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Create my first Linger passkey', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible({ timeout: 20_000 })
    expect(await page.evaluate(() => (window as unknown as { passkeyName?: string }).passkeyName)).toBe('person@example.com')
    const remember = page.getByRole('complementary', { name: 'Choose how to sign in next time' })
    await expect(remember.getByRole('checkbox')).not.toBeChecked()
    await remember.getByRole('checkbox').check()
    await remember.getByRole('combobox').selectOption('7')
    await remember.getByRole('button', { name: 'Save', exact: true }).click()

    const userId = (db.prepare('SELECT user_id AS id FROM passkey_credentials ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(forbiddenNetworkValues).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(userId)).toEqual({ count: 1 })

    // An opted-in reload validates the existing server session and restores the
    // vault, even before Google authorization has been completed.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Reconnect Google Drive', exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('linger_device_session_v1'))).not.toBeNull()
    const reopened = await context.newPage()
    await reopened.goto(origin)
    await expect(reopened.getByRole('button', { name: 'Reconnect Google Drive', exact: true })).toBeVisible()
    await expect(reopened.getByRole('heading', { name: 'Sign in to Linger' })).toHaveCount(0)
    await reopened.close()
    await page.evaluate(() => localStorage.removeItem('linger_device_session_v1'))

    await page.evaluate(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await expect(page.getByRole('heading', { name: 'Sign in to Linger' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create my first Linger passkey', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open Linger', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reconnect Google Drive', exact: true })).toBeVisible({ timeout: 20_000 })
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
    await page.evaluate(async internalId => {
      const path = '/src/api/passkeys.ts'
      const api = await import(/* @vite-ignore */ path)
      const listed = await api.listPasskeys(internalId)
      await api.renamePasskey(internalId, listed.currentCredentialId, 'Daily passkey')
      const renamed = await api.listPasskeys(internalId)
      if (renamed.credentials[0].name !== 'Daily passkey' || !renamed.credentials[0].lastUsedAt) throw new Error('Missing credential metadata')
    }, userId)
    const originalCredentialId = firstSession.currentCredentialId
    expect(originalCredentialId).toBeTruthy()
    expect(registrationRequests).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials').get()).toEqual({ count: 1 })
    // A second provider has a different PRF secret. It must wrap the existing
    // master key, rather than silently creating an unreadable new account key.
    const firstCredentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    const second = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
      hasPrf: true,
    } })
    authenticatorId = second.authenticatorId
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: firstCredentials.credentials[0] })
    removeCredentialBeforeAdd = { authenticatorId, credentialId: firstCredentials.credentials[0].credentialId }
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

    // A repeat Google-first signup in the same browser must stop before a new
    // WebAuthn registration, including after reload with the vault locked.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Open Linger', exact: true })).toBeVisible()
    await page.evaluate(() => {
      navigator.credentials.get = async () => { throw new DOMException('Dismissed', 'NotAllowedError') }
    })
    await page.getByRole('button', { name: 'Open Linger', exact: true }).click()
    await page.getByRole('button', { name: 'First time using Linger? Get started', exact: true }).click()
    await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('already been used')
    await expect(page.getByRole('button', { name: 'Sign in with a saved passkey', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create my first Linger passkey', exact: true })).toHaveCount(0)
    expect(registrationRequests).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials').get()).toEqual({ count: 1 })

    // The explicit lost-all-passkeys path still creates a usable new vault.
    await page.getByText('Having trouble with your passkey?', { exact: true }).click()
    await page.getByRole('button', { name: 'Set up again with the same Google account' }).click()
    await expect(page.getByRole('button', { name: 'Connect Google Drive', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: /I understand/ }).check()
    await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click()
    await expect(page.getByText('person@example.com', { exact: true })).toBeVisible()
    // Restore native WebAuthn for the new credential's PRF assertion.
    await page.evaluate(() => {
      navigator.credentials.get = CredentialsContainer.prototype.get.bind(navigator.credentials)
    })
    await page.getByRole('button', { name: 'Create my first Linger passkey', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible({ timeout: 20_000 })
    expect(registrationRequests).toBe(2)
    const recoveryUsers = db.prepare('SELECT user_id FROM passkey_credentials WHERE user_id != ?').all(userId)
    expect(recoveryUsers).toHaveLength(1)
    expect(forbiddenNetworkValues).toEqual([])

  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    db.close()
  }
})
