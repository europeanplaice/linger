import { accountRequest } from '../lib/accountSession'
import { clearOAuthCredentials, getAccessToken, getIdToken, setOAuthCredentials } from '../lib/oauthCredentials'
import { clearVaultKey, getVaultUserId, setVaultKeyHeader } from '../lib/passkeyVault'

let signInGeneration = 0
let cancelPendingSignIn: ((error: Error) => void) | null = null

export function startSignIn(options: { selectAccount?: boolean } = {}): Promise<SessionInfo> {
  const generation = ++signInGeneration
  cancelPendingSignIn?.(new Error('Google sign-in was superseded'))
  cancelPendingSignIn = null
  clearOAuthCredentials()
  return new Promise((resolve, reject) => {
    const channelId = crypto.randomUUID()
    let channel: BroadcastChannel | null = null
    if ('BroadcastChannel' in window) {
      try { channel = new BroadcastChannel(`linger-oauth-${channelId}`) } catch { /* postMessage remains the fallback. */ }
    }
    const params = new URLSearchParams({ channel_id: channelId })
    if (options.selectAccount) params.set('select_account', '1')
    const loginUrl = `/auth/login?${params.toString()}`
    const popup = window.open(loginUrl, 'linger-google-signin', 'popup,width=520,height=680')
    if (!popup) {
      channel?.close()
      reject(new Error('Google sign-in popup was blocked. Allow popups and try again.'))
      return
    }

    let finished = false
    let receivedCredential = false
    const finish = (error?: Error, info?: SessionInfo) => {
      if (finished) return
      finished = true
      window.removeEventListener('message', onMessage)
      channel?.close()
      window.clearInterval(closeCheck)
      window.clearTimeout(timeout)
      if (!popup.closed) popup.close()
      if (cancelPendingSignIn === cancel) cancelPendingSignIn = null
      if (error) {
        if (generation === signInGeneration) clearOAuthCredentials()
        reject(error)
      }
      else if (info) resolve(info)
      else reject(new Error('Google sign-in did not complete'))
    }
    const cancel = (error: Error) => finish(error)

    const handleMessage = (data: unknown, requireChannelId = false) => {
      const message = data as { type?: unknown; credential?: unknown; channelId?: unknown }
      if (message?.type !== 'linger-oauth-complete' || !message.credential || typeof message.credential !== 'object') return
      if (requireChannelId && message.channelId !== channelId) return
      if (message.channelId !== undefined && message.channelId !== channelId) return
      const credential = message.credential as { accessToken?: unknown; idToken?: unknown; expiresAt?: unknown }
      if (typeof credential.accessToken !== 'string' || typeof credential.idToken !== 'string' || typeof credential.expiresAt !== 'number') {
        finish(new Error('Google sign-in returned an invalid response'))
        return
      }
      if (receivedCredential) return
      receivedCredential = true
      try { setOAuthCredentials({ accessToken: credential.accessToken, idToken: credential.idToken, expiresAt: credential.expiresAt }) }
      catch (error) { finish(error instanceof Error ? error : new Error('Google sign-in failed')); return }
      checkSession().then(info => {
        if (!info.signedIn) throw new Error('Google sign-in could not be verified')
        try { channel?.postMessage({ type: 'linger-oauth-ack', channelId }) } catch { /* Sign-in can finish without the acknowledgement. */ }
        finish(undefined, info)
      }).catch(error => finish(error instanceof Error ? error : new Error('Google sign-in failed')))
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return
      handleMessage(event.data)
    }
    const onChannelMessage = (event: MessageEvent) => handleMessage(event.data, true)

    window.addEventListener('message', onMessage)
    if (channel) channel.addEventListener('message', onChannelMessage)
    const closeCheck = window.setInterval(() => {
      // Browsers may report a COOP-isolated OAuth popup as closed even while it
      // is still navigating through Google. BroadcastChannel can still deliver
      // the callback, so only use this cancellation check without that fallback.
      if (!channel && !receivedCredential && popup.closed) finish(new Error('Google sign-in was cancelled'))
    }, 250)
    const timeout = window.setTimeout(() => finish(new Error('Google sign-in timed out')), 5 * 60_000)
    cancelPendingSignIn = cancel
  })
}

export interface SessionInfo {
  signedIn: boolean
  email: string | null
  googleSub: string | null
  googleClientId: string | null
  userId: string | null
}

export async function checkSession(): Promise<SessionInfo> {
  const accessToken = getAccessToken()
  if (!accessToken) return { signedIn: false, email: null, googleSub: null, googleClientId: null, userId: null }
  const requestVaultUserId = getVaultUserId()
  try {
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    setVaultKeyHeader(headers)
    const idToken = getIdToken()
    if (idToken) headers.set('X-Linger-Google-ID-Token', idToken)
    const resp = await fetch('/auth/session', { credentials: 'include', headers, cache: 'no-store', redirect: 'error' })
    if (resp.status === 401) return { signedIn: false, email: null, googleSub: null, googleClientId: null, userId: null }
    const data = await resp.json() as { signedIn: boolean; email?: string | null; googleSub?: string | null; googleClientId?: string | null; userId?: string | null }
    const unlockedUserId = getVaultUserId()
    if (requestVaultUserId && unlockedUserId !== requestVaultUserId) {
      return { signedIn: false, email: null, googleSub: null, googleClientId: null, userId: null }
    }
    if (unlockedUserId && data.userId && unlockedUserId !== data.userId) {
      if (requestVaultUserId === unlockedUserId) {
        clearVaultKey()
        clearOAuthCredentials()
      }
      return { signedIn: false, email: null, googleSub: null, googleClientId: null, userId: null }
    }
    return {
      signedIn: Boolean(data.signedIn),
      email: data.email ?? null,
      googleSub: data.googleSub ?? null,
      googleClientId: data.googleClientId ?? null,
      userId: data.userId ?? null,
    }
  } catch {
    return { signedIn: false, email: null, googleSub: null, googleClientId: null, userId: null }
  }
}

export async function revokeSession(): Promise<void> {
  signInGeneration++
  cancelPendingSignIn?.(new Error('Google sign-in was cancelled by logout'))
  cancelPendingSignIn = null
  clearOAuthCredentials()
  const { init } = accountRequest({ method: 'POST' })
  const headers = new Headers(init.headers)
  setVaultKeyHeader(headers)
  clearVaultKey()
  const response = await fetch('/auth/logout', { ...init, headers, credentials: 'include', redirect: 'error' })
  if (!response.ok) throw new Error('Logout failed')
}
