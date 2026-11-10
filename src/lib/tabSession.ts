import { getVaultKey, getVaultUserId, unlockVaultWithKey } from './passkeyVault'

const STORAGE_KEY = 'linger_tab_session_v1'
const DEVICE_KEY = 'linger_device_session_v1'
const LIFETIME = 7 * 24 * 60 * 60 * 1000
export type RememberDays = 0 | 1 | 7
export type TabSessionRestore = 'restored' | 'missing' | 'unavailable'
let expiresAt = 0
let persistent = false
let newDeviceSession = false
let expirationTimer: ReturnType<typeof setTimeout> | undefined

export function hasDeviceSession(): boolean {
  return getDeviceSessionExpiry() !== null
}

export function getDeviceSessionExpiry(): number | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY)
    const at = raw ? (JSON.parse(raw) as { expiresAt?: unknown }).expiresAt : null
    return typeof at === 'number' && Number.isFinite(at) && at > Date.now() && at <= Date.now() + LIFETIME ? at : null
  } catch { return null }
}

export function clearTabSession(): void {
  expiresAt = 0
  persistent = false
  newDeviceSession = false
  clearTimeout(expirationTimer)
  expirationTimer = undefined
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* Storage may be disabled. */ }
  try { localStorage.removeItem(DEVICE_KEY) } catch { /* Storage may be disabled. */ }
}

function scheduleExpiry(at: number): void {
  expiresAt = at
  clearTimeout(expirationTimer)
  expirationTimer = setTimeout(() => {
    try {
      const raw = persistent ? localStorage.getItem(DEVICE_KEY) : sessionStorage.getItem(STORAGE_KEY)
      if (raw && (JSON.parse(raw) as { expiresAt?: number }).expiresAt !== at) {
        expiresAt = 0
        persistent = false
        newDeviceSession = false
        return
      }
    } catch { /* Invalid records are removed below. */ }
    clearTabSession()
  }, Math.max(0, at - Date.now()))
}

export function enableTabSession(days: 1 | 7 = 7): void { persistent = true; newDeviceSession = true; scheduleExpiry(Date.now() + (days === 1 ? 1 : 7) * 24 * 60 * 60 * 1000) }

export function saveTabSession(): void {
  if (expiresAt <= Date.now()) { clearTabSession(); return }
  const userId = getVaultUserId()
  const key = getVaultKey()
  if (!userId || !key) return
  try {
    const encoded = btoa(String.fromCharCode(...key))
    if (persistent) {
      const previous = localStorage.getItem(DEVICE_KEY)
      if (!previous && !newDeviceSession) return
      // A different tab may have disabled or replaced the saved device session.
      if (previous) {
        const saved = JSON.parse(previous) as { userId?: string; expiresAt?: number }
        if (saved.userId !== userId || saved.expiresAt !== expiresAt) return
      }
      localStorage.setItem(DEVICE_KEY, JSON.stringify({ userId, key: encoded, expiresAt }))
      newDeviceSession = false
    }
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, key: encoded, expiresAt }))
  } catch { clearTabSession() } finally { key.fill(0) }
}

export async function restoreTabSession(isCurrent: () => boolean = () => true): Promise<TabSessionRestore> {
  try {
    const deviceRaw = localStorage.getItem(DEVICE_KEY)
    const storage = deviceRaw ? localStorage : sessionStorage
    const storageKey = deviceRaw ? DEVICE_KEY : STORAGE_KEY
    const raw = deviceRaw ?? storage.getItem(storageKey)
    if (!raw) return 'missing'
    const value = JSON.parse(raw) as { userId: string; key: string; expiresAt: number }
    if (typeof value.userId !== 'string' || !value.userId || typeof value.key !== 'string' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + LIFETIME) throw new Error('Invalid saved session')
    // Rewrite older sessions before the network request to discard stored OAuth tokens.
    const sanitized = JSON.stringify({ userId: value.userId, key: value.key, expiresAt: value.expiresAt })
    storage.setItem(storageKey, sanitized)
    const key = Uint8Array.from(atob(value.key), c => c.charCodeAt(0))
    if (key.length !== 32) throw new Error('Invalid saved key')
    try {
      const headers = new Headers({ 'X-Linger-Vault-User': value.userId, 'X-Linger-Vault-Key': value.key.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') })
      const response = await fetch('/auth/passkey/session', { headers, credentials: 'include', cache: 'no-store', redirect: 'error' }).catch(() => null)
      if (!isCurrent() || storage.getItem(storageKey) !== sanitized || (!deviceRaw && localStorage.getItem(DEVICE_KEY))) return 'missing'
      if (value.expiresAt <= Date.now() || response?.status === 401 || response?.status === 403) {
        clearTabSession()
        return 'missing'
      }
      if (!response?.ok) return 'unavailable'
      unlockVaultWithKey(value.userId, key)
      persistent = Boolean(deviceRaw)
      scheduleExpiry(value.expiresAt)
      saveTabSession()
      return 'restored'
    } finally { key.fill(0) }
  } catch { if (isCurrent()) clearTabSession(); return 'missing' }
}
