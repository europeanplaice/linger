const SESSION_USER_KEY = 'linger_session_user'
const OWNER_HASH_PREFIX = 'sha256:'
const UNKNOWN_OWNER = '__unknown__'

export const LEGACY_MIRROR_OWNER_KEY = 'linger_local_mirror_legacy_owner'
export const LEGACY_QUEUE_OWNER_KEY = 'linger_legacy_queue_owner'
export const LEGACY_MIRROR_PREFIX = 'linger_local_entry_'
export const LEGACY_QUEUE_KEY = 'linger_pending_sync_queue'

async function hashOwner(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(`linger-session-owner-v1:${email.trim().toLowerCase()}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return OWNER_HASH_PREFIX + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function isOwnerHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value)
}

function normalizeOwner(value: string | null): string | null | Promise<string> {
  return value && value !== UNKNOWN_OWNER && !isOwnerHash(value) ? hashOwner(value) : value
}

export function readSessionOwner(): string | null {
  return localStorage.getItem(SESSION_USER_KEY)
}

export function readLegacyOwner(ownerKey: string): string | null {
  return localStorage.getItem(ownerKey) ?? readSessionOwner()
}

export async function matchesLocalSessionOwner(stored: string, email: string): Promise<boolean> {
  return await normalizeOwner(stored) === await hashOwner(email)
}

export async function canRecoverLegacyOwner(stored: string | null, email: string): Promise<boolean> {
  return !stored || stored === UNKNOWN_OWNER || await matchesLocalSessionOwner(stored, email)
}

/** Replace old plaintext markers. An undefined email preserves the current session owner during restoration. */
export async function updateLocalSessionOwner(email: string | null | undefined, isCurrent: () => boolean): Promise<void> {
  const nextOwner = email === undefined ? undefined : email?.trim() ? await hashOwner(email) : null
  while (isCurrent()) {
    const session = readSessionOwner()
    const mirror = localStorage.getItem(LEGACY_MIRROR_OWNER_KEY)
    const queue = localStorage.getItem(LEGACY_QUEUE_OWNER_KEY)
    const [sessionHash, mirrorHash, queueHash] = await Promise.all([
      normalizeOwner(session), normalizeOwner(mirror), normalizeOwner(queue),
    ])
    if (!isCurrent()) return
    // Another tab may have changed the markers while a digest was in flight.
    if (readSessionOwner() !== session || localStorage.getItem(LEGACY_MIRROR_OWNER_KEY) !== mirror ||
        localStorage.getItem(LEGACY_QUEUE_OWNER_KEY) !== queue) continue

    // Pin the old owner before replacing the session marker. Recovery remains
    // explicit and unavailable to any account that differs from a known owner.
    if (Object.keys(localStorage).some(key => key.startsWith(LEGACY_MIRROR_PREFIX))) {
      const owner = mirrorHash ?? sessionHash ?? UNKNOWN_OWNER
      if (mirror !== owner) localStorage.setItem(LEGACY_MIRROR_OWNER_KEY, owner)
    } else if (mirror !== null) localStorage.removeItem(LEGACY_MIRROR_OWNER_KEY)
    if (localStorage.getItem(LEGACY_QUEUE_KEY) !== null) {
      const owner = queueHash ?? sessionHash ?? UNKNOWN_OWNER
      if (queue !== owner) localStorage.setItem(LEGACY_QUEUE_OWNER_KEY, owner)
    } else if (queue !== null) localStorage.removeItem(LEGACY_QUEUE_OWNER_KEY)

    const owner = nextOwner === undefined ? sessionHash : nextOwner
    if (owner === null) localStorage.removeItem(SESSION_USER_KEY)
    else if (session !== owner) localStorage.setItem(SESSION_USER_KEY, owner)
    return
  }
}
