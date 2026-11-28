import { getVaultKey, getVaultUserId } from './passkeyVault'

const CHANNEL_NAME = 'linger_vault_handoff'

type VaultHandoffMessage =
  | { type: 'VAULT_KEY_REQUEST'; requestId: string }
  | { type: 'VAULT_KEY_RESPONSE'; requestId: string; userId: string; key: Uint8Array }
  | { type: 'VAULT_LOCKED' }
  | { type: 'DEVICE_SESSION_CHANGED' }

export interface VaultHandoffHandlers {
  onLocked?: () => void
  onDeviceSessionChanged?: () => void
}

function openChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(CHANNEL_NAME)
  } catch {
    return null
  }
}

export function broadcastVaultLock(): void {
  const channel = openChannel()
  if (!channel) return
  try {
    channel.postMessage({ type: 'VAULT_LOCKED' } satisfies VaultHandoffMessage)
  } catch { /* Ignore closed or unavailable channel. */ } finally {
    channel.close()
  }
}

export function broadcastDeviceSessionChanged(): void {
  const channel = openChannel()
  if (!channel) return
  try {
    channel.postMessage({ type: 'DEVICE_SESSION_CHANGED' } satisfies VaultHandoffMessage)
  } catch { /* Ignore closed or unavailable channel. */ } finally {
    channel.close()
  }
}

export function subscribeVaultHandoff(handlers: VaultHandoffHandlers): () => void {
  const channel = openChannel()
  if (!channel) return () => {}

  const onMessage = (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<VaultHandoffMessage> | null | undefined
    if (!data || typeof data !== 'object') return

    if (data.type === 'VAULT_KEY_REQUEST' && typeof data.requestId === 'string' && data.requestId) {
      const userId = getVaultUserId()
      const key = userId ? getVaultKey(userId) : null
      if (!userId || !key) return
      try {
        channel.postMessage({
          type: 'VAULT_KEY_RESPONSE',
          requestId: data.requestId,
          userId,
          key,
        } satisfies VaultHandoffMessage)
      } catch { /* Ignore structured-clone or closed-channel errors. */ } finally {
        key.fill(0)
      }
      return
    }

    if (data.type === 'VAULT_LOCKED') {
      handlers.onLocked?.()
      return
    }

    if (data.type === 'DEVICE_SESSION_CHANGED') {
      handlers.onDeviceSessionChanged?.()
    }
  }

  channel.addEventListener('message', onMessage)
  return () => {
    channel.removeEventListener('message', onMessage)
    channel.close()
  }
}

/**
 * Requests the in-memory vault key from another open same-origin Linger tab.
 * Callers must verify the returned key against `/auth/passkey/session` and zero
 * `key` in a `finally` block.
 */
export function requestVaultKeyFromSiblingTab(
  timeoutMs = 120,
): Promise<{ userId: string; key: Uint8Array<ArrayBuffer> } | null> {
  const channel = openChannel()
  if (!channel) return Promise.resolve(null)

  const requestId = crypto.randomUUID()
  return new Promise(resolve => {
    let settled = false
    const finish = (result: { userId: string; key: Uint8Array<ArrayBuffer> } | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      channel.close()
      resolve(result)
    }

    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<VaultHandoffMessage> | null | undefined
      if (!data || typeof data !== 'object' || data.type !== 'VAULT_KEY_RESPONSE') return
      if (data.requestId !== requestId) return
      if (typeof data.userId !== 'string' || !data.userId) return
      if (!(data.key instanceof Uint8Array) || data.key.length !== 32) return
      const keyCopy = new Uint8Array(data.key)
      try { data.key.fill(0) } catch { /* Read-only views are harmless. */ }
      finish({ userId: data.userId, key: keyCopy })
    }

    const timer = setTimeout(() => finish(null), timeoutMs)
    channel.addEventListener('message', onMessage)
    try {
      channel.postMessage({ type: 'VAULT_KEY_REQUEST', requestId } satisfies VaultHandoffMessage)
    } catch {
      finish(null)
    }
  })
}
