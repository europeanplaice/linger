import { getOAuthCredentials, setOAuthCredentials } from './oauthCredentials'
import { getVaultKey, getVaultUserId, unlockVaultWithKey } from './passkeyVault'

const STORAGE_KEY = 'linger_tab_session_v1'
const LIFETIME = 8 * 60 * 60 * 1000
let expiresAt = 0
let expirationTimer: ReturnType<typeof setTimeout> | undefined

export function clearTabSession(): void {
  expiresAt = 0
  clearTimeout(expirationTimer)
  expirationTimer = undefined
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* Storage may be disabled. */ }
}

function scheduleExpiry(at: number): void {
  expiresAt = at
  clearTimeout(expirationTimer)
  expirationTimer = setTimeout(clearTabSession, Math.max(0, at - Date.now()))
}

export function enableTabSession(): void { scheduleExpiry(Date.now() + LIFETIME) }

export function saveTabSession(): void {
  if (expiresAt <= Date.now()) { clearTabSession(); return }
  const userId = getVaultUserId()
  const key = getVaultKey()
  if (!userId || !key) return
  try {
    const encoded = btoa(String.fromCharCode(...key))
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, key: encoded, expiresAt, oauth: getOAuthCredentials() }))
  } catch { clearTabSession() } finally { key.fill(0) }
}

export async function restoreTabSession(isCurrent: () => boolean = () => true): Promise<boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const value = JSON.parse(raw) as { userId: string; key: string; expiresAt: number; oauth?: { accessToken: string; idToken: string; expiresAt: number } | null }
    if (typeof value.userId !== 'string' || !value.userId || typeof value.key !== 'string' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + LIFETIME) throw new Error('Invalid saved session')
    const key = Uint8Array.from(atob(value.key), c => c.charCodeAt(0))
    if (key.length !== 32) throw new Error('Invalid saved key')
    try {
      const headers = new Headers({ 'X-Linger-Vault-User': value.userId, 'X-Linger-Vault-Key': value.key.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') })
      const response = await fetch('/auth/passkey/session', { headers, credentials: 'include', cache: 'no-store', redirect: 'error' })
      if (!response.ok || !isCurrent()) throw new Error('Saved session unavailable')
      unlockVaultWithKey(value.userId, key)
      scheduleExpiry(value.expiresAt)
      if (value.oauth && typeof value.oauth.accessToken === 'string' && typeof value.oauth.idToken === 'string' && typeof value.oauth.expiresAt === 'number' && value.oauth.expiresAt > Date.now() + 5000) setOAuthCredentials(value.oauth)
      saveTabSession()
      return true
    } finally { key.fill(0) }
  } catch { if (isCurrent()) clearTabSession(); return false }
}
