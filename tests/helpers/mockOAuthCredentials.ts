import type { Page, BrowserContext } from '@playwright/test'

/**
 * Replace the app's OAuth credential module inside a browser test with a
 * request-scoped in-memory credential fixture. This is a module interception,
 * not a production global hook; no tokens are written to browser storage.
 */
export async function installMockOAuthCredentials(
  target: Page | BrowserContext,
  options: { seedOnModuleLoad?: number | 'all'; seedVaultOnModuleLoad?: number | 'all' } = {},
): Promise<void> {
  let moduleLoads = 0
  let vaultModuleLoads = 0
  await target.route('**/src/lib/oauthCredentials.ts*', route => {
    moduleLoads++
    const seedThisLoad = options.seedOnModuleLoad === undefined || options.seedOnModuleLoad === 'all' || moduleLoads === options.seedOnModuleLoad
    const body = !seedThisLoad
      ? `
          let current = null;
          export function setOAuthCredentials(value) { current = { ...value }; }
          export function getOAuthCredentials() { return getAccessToken() ? { ...current } : null; }
          export function getAccessToken() { return current && current.expiresAt > Date.now() + 5000 ? current.accessToken : null; }
          export function getIdToken() { return getAccessToken() ? current.idToken : null; }
          export function clearOAuthCredentials() { current = null; }
        `
      : `
          let current = { accessToken: 'e2e-access-token', idToken: 'e2e-id-token', expiresAt: Date.now() + 3600000 };
          export function setOAuthCredentials(value) { current = { ...value }; }
          export function getOAuthCredentials() { return getAccessToken() ? { ...current } : null; }
          export function getAccessToken() { return current && current.expiresAt > Date.now() + 5000 ? current.accessToken : null; }
          export function getIdToken() { return getAccessToken() ? current.idToken : null; }
          export function clearOAuthCredentials() { current = null; }
        `
    return route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body,
    })
  })
  await target.route('**/passkeyVault*', route => {
    vaultModuleLoads++
    const seedVault = options.seedVaultOnModuleLoad === undefined || options.seedVaultOnModuleLoad === 'all' || vaultModuleLoads === options.seedVaultOnModuleLoad
    const userId = '624a7c5a-7c13-4c62-a14d-3f8c3bd516f8'
    const body = `
      let current = ${seedVault ? `{ internalUserId: '${userId}', rawKey: new Uint8Array(32).fill(43) }` : 'null'};
      let revision = 0;
      const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
      export function getVaultKey(id) { return current && (!id || id === current.internalUserId) ? new Uint8Array(current.rawKey) : null; }
      export function getVaultUserId() { return current?.internalUserId ?? null; }
      export const getVaultInternalUserId = getVaultUserId;
      export function getVaultRevision() { return revision; }
      export function clearVaultKey() { revision++; current?.rawKey.fill(0); current = null; }
      export function vaultKeyHeader(id) { const key = getVaultKey(id); if (!key) return null; try { return b64(key); } finally { key.fill(0); } }
      export function setVaultKeyHeader(headers, id) { headers.delete('X-Linger-Vault-Key'); headers.delete('X-Linger-Vault-User'); const value = vaultKeyHeader(id); const user = id ?? current?.internalUserId; if (value && user) { headers.set('X-Linger-Vault-Key', value); headers.set('X-Linger-Vault-User', user); } }
      export function setVaultHeadersForKey(headers, id, key) { headers.set('X-Linger-Vault-Key', b64(key)); headers.set('X-Linger-Vault-User', id); }
      export function unlockVaultWithKey(id, key) { clearVaultKey(); current = { internalUserId: id, rawKey: new Uint8Array(key) }; }
      export async function unlockWrappedMasterKey(_prf, id) { revision++; current = { internalUserId: id, rawKey: new Uint8Array(32).fill(43) }; }
      export async function createWrappedMasterKey(_prf, id, credentialId) { revision++; const rawKey = new Uint8Array(32).fill(43); current = { internalUserId: id, rawKey: new Uint8Array(rawKey) }; return { version: 1, credentialId, hkdfSalt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; }
      export async function wrapExistingMasterKey(_prf, id, credentialId) { return { version: 1, credentialId, hkdfSalt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }; }
      export function serializeWrappedMasterKey() { return { wrappedMasterKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', prfSalt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }; }
      export function parseWrappedMasterKey(payload, credentialId) { return { version: 1, credentialId, hkdfSalt: payload.prfSalt, iv: payload.wrappedMasterKey.slice(0,16), ciphertext: payload.wrappedMasterKey.slice(16) }; }
      export function copyPrfOutput(value) { return value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)); }
      export async function encryptVaultValue() { throw new Error('Test vault fixture does not encrypt metadata'); }
      export async function decryptVaultValue() { throw new Error('Test vault fixture does not decrypt metadata'); }
    `
    return route.fulfill({ status: 200, contentType: 'application/javascript', body })
  })
  // Browser tests mock the endpoints they exercise. Keep unrelated S3 polling
  // from reaching the local Pages worker, where an unauthenticated 401 would
  // open the session-expired dialog and obscure the UI under test. Per-test
  // routes registered later still take precedence for the endpoint being tested.
  await target.route('**/api/s3/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/s3/settings' && route.request().method() === 'GET') {
      return route.fulfill({ json: null })
    }
    if (pathname.startsWith('/api/s3/entry-status/')) {
      return route.fulfill({ json: { status: 'disabled' } })
    }
    if (pathname === '/api/s3/restore' && route.request().method() === 'GET') {
      return route.fulfill({ json: { dates: [] } })
    }
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
}
