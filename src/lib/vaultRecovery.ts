import { getVaultKey, getVaultUserId } from './passkeyVault'

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < value.length; i += 0x8000) binary += String.fromCharCode(...value.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export function exportVaultRecovery(): string {
  const userId = getVaultUserId()
  const key = getVaultKey(userId ?? undefined)
  if (!userId || !key) throw new Error('Unlock the passkey vault before exporting a recovery file')
  try {
    return JSON.stringify({ version: 1, userId, masterKey: encodeBase64Url(key) }, null, 2)
  } finally { key.fill(0) }
}

export function parseVaultRecoveryFile(value: string): { userId: string; masterKey: Uint8Array<ArrayBuffer> } {
  if (value.length > 2048) throw new Error('Recovery file is too large')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('Recovery file is not valid JSON') }
  if (!parsed || typeof parsed !== 'object') throw new Error('Recovery file is invalid')
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || typeof record.userId !== 'string' || !USER_ID_RE.test(record.userId) || typeof record.masterKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.masterKey)) {
    throw new Error('Recovery file has an unsupported format')
  }
  const masterKey = decodeBase64Url(record.masterKey)
  if (masterKey.length !== 32) {
    masterKey.fill(0)
    throw new Error('Recovery file has an invalid key')
  }
  return { userId: record.userId, masterKey }
}
