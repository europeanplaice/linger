import { broadcastMessage, subscribeTabSync } from '../utils/tabSync'
import { clearOAuthCredentials } from './oauthCredentials'

export const ACCOUNT_HEADER = 'X-Linger-Account'
export const AUTH_EVENT_KEY = 'linger_auth_event'
const INVALIDATED_EVENT = 'linger-account-invalidated'

interface AuthEvent { id: string; account: string | null; persisted?: boolean }
interface AccountSnapshot { account: string | null; clearSharedData: boolean; verifiedEmail: string | null }
let current: AccountSnapshot = { account: null, clearSharedData: true, verifiedEmail: null }
let lastAnnouncedId: string | undefined

export function accountIdentity(info: { googleSub?: string | null; email?: string | null }): string | null {
  if (info.googleSub) return `sub:${info.googleSub}`
  return info.email ? `email:${encodeURIComponent(info.email.trim().toLowerCase())}` : null
}

export function getAccountSnapshot(): AccountSnapshot { return current }

export function setActiveAccount(account: string | null, clearSharedData = false, verifiedEmail: string | null = null): void {
  const email = account ? verifiedEmail : null
  if (current.account === account && current.clearSharedData === clearSharedData && current.verifiedEmail === email) return
  current = { account, clearSharedData, verifiedEmail: email }
}

export function invalidateAccount(): void {
  clearOAuthCredentials()
  setActiveAccount(null)
  window.dispatchEvent(new Event(INVALIDATED_EVENT))
}

export function readAuthEvent(): AuthEvent | null {
  try {
    const value = JSON.parse(localStorage.getItem(AUTH_EVENT_KEY) ?? 'null')
    return value && typeof value.id === 'string' && (value.account === null || typeof value.account === 'string') ? value : null
  } catch { return null }
}

export function announceAccount(account: string | null): void {
  if (account !== null && readAuthEvent()?.account === account) return
  const event = { id: crypto.randomUUID(), account, persisted: true }
  lastAnnouncedId = event.id
  try { localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify(event)) } catch { event.persisted = false }
  broadcastMessage({ type: 'AUTH_CHANGED', ...event })
}

export function subscribeAccountChanges(onChange: (event: AuthEvent) => void, onInvalidated: () => void): () => void {
  let lastId = readAuthEvent()?.id
  const receive = (event: AuthEvent | null) => {
    // An older BroadcastChannel message can arrive after a newer storage event.
    // Prefer the shared record so a delayed logout cannot hide a new sign-in.
    const latest = readAuthEvent()
    if (latest && event && event.persisted !== false && latest.id !== event.id) event = latest
    if (!event || event.id === lastId) return
    lastId = event.id
    // Focus can rediscover this tab's own logout while a new login is underway.
    if (event.id === lastAnnouncedId) return
    onChange(event)
  }
  const onStorage = (event: StorageEvent) => { if (event.key === AUTH_EVENT_KEY || event.key === null) receive(readAuthEvent()) }
  const onFocus = () => { if (document.visibilityState !== 'hidden') receive(readAuthEvent()) }
  const unsubscribe = subscribeTabSync(event => { if (event.type === 'AUTH_CHANGED') receive(event) })
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  window.addEventListener(INVALIDATED_EVENT, onInvalidated)
  return () => {
    unsubscribe()
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onFocus)
    window.removeEventListener(INVALIDATED_EVENT, onInvalidated)
  }
}

// Capture once per operation, so retries retain the original account even when
// the browser's shared session cookie changes in another tab.
export function accountRequest(init?: RequestInit): { init: RequestInit; assertCurrent: () => void } {
  const snapshot = current
  const headers = new Headers(init?.headers)
  headers.set(ACCOUNT_HEADER, snapshot.account ?? 'unbound')
  return {
    init: { ...init, headers },
    assertCurrent: () => {
      if (current !== snapshot) throw new DOMException('Account changed', 'AbortError')
    },
  }
}
