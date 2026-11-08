import { expect, test } from '@playwright/test'
import { createPasskeyTestEnv } from './helpers/passkeyAuth'
import type { Env } from '../functions/_shared/session'
import {
  addOptions, addVerify, loginOptions, loginVerify,
  recoverSession, registrationOptions, registrationVerify,
} from '../functions/_shared/passkeys'

// Native Chrome WebAuthn + real server verification + migrated SQL. Only the
// HTTP transport is intercepted, so mocked signature verification cannot hide
// a mismatch between browser options, PRF bytes, wrappers, and backend handlers.
test('registers, unlocks, and recovers a PRF vault with real WebAuthn signatures', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator requires CDP')
  const origin = 'http://localhost:5173'
  const { env, db } = await createPasskeyTestEnv({}, { domain: origin })
  const handlers: Record<string, (request: Request, environment: Env) => Promise<Response>> = {
    '/register/options': registrationOptions, '/register/verify': registrationVerify,
    '/login/options': loginOptions, '/login/verify': loginVerify,
    '/add/options': addOptions, '/add/verify': addVerify,
    '/recover': recoverSession,
  }
  const forbiddenNetworkValues: string[] = []
  await page.route('**/auth/passkey/**', async route => {
    const incoming = route.request()
    const path = new URL(incoming.url()).pathname.replace('/auth/passkey', '')
    const handler = handlers[path]
    if (!handler) { await route.fulfill({ status: 404 }); return }
    const body = incoming.postData()
    if (body?.includes('"results"')) forbiddenNetworkValues.push('PRF result sent to server')
    const request = new Request(incoming.url(), {
      method: incoming.method(), headers: await incoming.allHeaders(),
      ...(body ? { body } : {}),
    })
    const response = await handler(request, env)
    for (const cookie of response.headers.getSetCookie()) {
      const fields = cookie.split(';').map(part => part.trim())
      const equals = fields[0].indexOf('=')
      const path = fields.find(part => part.startsWith('Path='))?.slice(5) ?? '/'
      const maxAge = Number(fields.find(part => part.startsWith('Max-Age='))?.slice(8) ?? 300)
      await context.addCookies([{
        name: fields[0].slice(0, equals), value: decodeURIComponent(fields[0].slice(equals + 1)),
        domain: 'localhost', path, httpOnly: fields.includes('HttpOnly'), sameSite: 'Strict',
        expires: maxAge === 0 ? 1 : Math.floor(Date.now() / 1000) + maxAge,
      }])
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
    await expect(page.getByRole('heading', { name: 'Protect your account with a passkey' })).toBeVisible()
    await page.getByRole('button', { name: 'Set up a passkey', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible({ timeout: 20_000 })

    const recovery = await page.evaluate(async () => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).exportVaultRecovery() as string
    })
    const userId = (JSON.parse(recovery) as { userId: string }).userId
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(forbiddenNetworkValues).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(userId)).toEqual({ count: 1 })

    await page.evaluate(async () => {
      const path = '/src/lib/passkeyVault.ts'
      const vault = await import(/* @vite-ignore */ path)
      vault.clearVaultKey()
    })
    await page.evaluate(async () => {
      const path = '/src/api/passkeys.ts'
      await (await import(/* @vite-ignore */ path)).loginWithPasskey()
    })
    const recoveredAgain = await page.evaluate(async () => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).exportVaultRecovery() as string
    })
    expect(recoveredAgain).toBe(recovery)

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
    await page.evaluate(async () => {
      const vaultPath = '/src/lib/passkeyVault.ts'
      const apiPath = '/src/api/passkeys.ts'
      ;(await import(/* @vite-ignore */ vaultPath)).clearVaultKey()
      await (await import(/* @vite-ignore */ apiPath)).loginWithPasskey()
    })
    expect(await page.evaluate(async () => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).exportVaultRecovery() as string
    })).toBe(recovery)

    await page.evaluate(async text => {
      const vaultPath = '/src/lib/passkeyVault.ts'
      const apiPath = '/src/api/passkeys.ts'
      ;(await import(/* @vite-ignore */ vaultPath)).clearVaultKey()
      await (await import(/* @vite-ignore */ apiPath)).recoverVault(text)
    }, recovery)
    const afterRecovery = await page.evaluate(async () => {
      const path = '/src/api/passkeys.ts'
      return (await import(/* @vite-ignore */ path)).exportVaultRecovery() as string
    })
    expect(afterRecovery).toBe(recovery)
    const dump = JSON.stringify(db.prepare('SELECT * FROM passkey_users WHERE id = ?').get(userId))
    expect(dump).not.toContain((JSON.parse(recovery) as { masterKey: string }).masterKey)
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(JSON.stringify(storage)).not.toContain((JSON.parse(recovery) as { masterKey: string }).masterKey)
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    db.close()
  }
})
