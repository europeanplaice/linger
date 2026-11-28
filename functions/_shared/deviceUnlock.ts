import { decodeVaultBytes } from './vaultCrypto'

export const DEVICE_UNLOCK_COOKIE = 'linger_device_unlock'
export const DEVICE_UNLOCK_PATH = '/auth/passkey/device-unlock'
export const ALLOWED_DEVICE_UNLOCK_DAYS = [1, 7] as const
export const MAX_DEVICE_UNLOCK_MS = 7 * 24 * 60 * 60 * 1000
export const DEVICE_UNLOCK_CLOCK_SKEW_MS = 60_000

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const EXPIRES_AT_PATTERN = /^\d{1,16}$/
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface ParsedDeviceUnlockCookie {
  userId: string
  expiresAt: number
  secret: string
}

export function makeDeviceUnlockCookie(
  userId: string,
  expiresAt: number,
  secret: string,
  maxAgeSeconds: number,
  secure = true,
): string {
  const secureFlag = secure ? '; Secure' : ''
  const value = `v1.${userId}.${expiresAt}.${secret}`
  return `${DEVICE_UNLOCK_COOKIE}=${encodeURIComponent(value)}; HttpOnly${secureFlag}; SameSite=Strict; Path=${DEVICE_UNLOCK_PATH}; Max-Age=${maxAgeSeconds}`
}

export function clearDeviceUnlockCookie(secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${DEVICE_UNLOCK_COOKIE}=; HttpOnly${secureFlag}; SameSite=Strict; Path=${DEVICE_UNLOCK_PATH}; Max-Age=0`
}

export function parseDeviceUnlockCookie(request: Request): ParsedDeviceUnlockCookie | null {
  const header = request.headers.get('Cookie') ?? ''
  let raw: string | null = null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq) !== DEVICE_UNLOCK_COOKIE) continue
    const encoded = trimmed.slice(eq + 1)
    if (!encoded) return null
    try { raw = decodeURIComponent(encoded) } catch { return null }
    break
  }
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  const [, userId, expiresRaw, secret] = parts
  if (!USER_ID_PATTERN.test(userId) || !EXPIRES_AT_PATTERN.test(expiresRaw) || !SECRET_PATTERN.test(secret)) {
    return null
  }
  const expiresAt = Number(expiresRaw)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null
  try {
    if (decodeVaultBytes(secret).length !== 32) return null
  } catch {
    return null
  }
  return { userId, expiresAt, secret }
}
