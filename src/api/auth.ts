import { accountRequest } from '../lib/accountSession'
import { clearOAuthCredentials, getAccessToken, getIdToken, setOAuthCredentials } from '../lib/oauthCredentials'

let signInGeneration = 0
let cancelPendingSignIn: ((error: Error) => void) | null = null

export function startSignIn(options: { selectAccount?: boolean } = {}): Promise<SessionInfo> {
  const generation = ++signInGeneration
  cancelPendingSignIn?.(new Error('Google sign-in was superseded'))
  cancelPendingSignIn = null
  clearOAuthCredentials()
  return new Promise((resolve, reject) => {
    const loginUrl = options.selectAccount ? '/auth/login?select_account=1' : '/auth/login'
    const popup = window.open(loginUrl, 'linger-google-signin', 'popup,width=520,height=680')
    if (!popup) {
      reject(new Error('Google sign-in popup was blocked. Allow popups and try again.'))
      return
    }

    let finished = false
    let receivedCredential = false
    const finish = (error?: Error, info?: SessionInfo) => {
      if (finished) return
      finished = true
      window.removeEventListener('message', onMessage)
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

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return
      const message = event.data as { type?: unknown; credential?: unknown }
      if (message?.type !== 'linger-oauth-complete' || !message.credential || typeof message.credential !== 'object') return
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
        finish(undefined, info)
      }).catch(error => finish(error instanceof Error ? error : new Error('Google sign-in failed')))
    }

    window.addEventListener('message', onMessage)
    const closeCheck = window.setInterval(() => {
      if (!receivedCredential && popup.closed) finish(new Error('Google sign-in was cancelled'))
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
}

export async function checkSession(): Promise<SessionInfo> {
  const accessToken = getAccessToken()
  if (!accessToken) return { signedIn: false, email: null, googleSub: null, googleClientId: null }
  try {
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    const idToken = getIdToken()
    if (idToken) headers.set('X-Linger-Google-ID-Token', idToken)
    const resp = await fetch('/auth/session', { credentials: 'include', headers, cache: 'no-store', redirect: 'error' })
    if (resp.status === 401) return { signedIn: false, email: null, googleSub: null, googleClientId: null }
    const data = await resp.json() as { signedIn: boolean; email?: string | null; googleSub?: string | null; googleClientId?: string | null }
    return {
      signedIn: Boolean(data.signedIn),
      email: data.email ?? null,
      googleSub: data.googleSub ?? null,
      googleClientId: data.googleClientId ?? null,
    }
  } catch {
    return { signedIn: false, email: null, googleSub: null, googleClientId: null }
  }
}

export async function revokeSession(): Promise<void> {
  signInGeneration++
  cancelPendingSignIn?.(new Error('Google sign-in was cancelled by logout'))
  cancelPendingSignIn = null
  clearOAuthCredentials()
  const { init } = accountRequest({ method: 'POST' })
  const response = await fetch('/auth/logout', { ...init, credentials: 'include' })
  if (!response.ok) throw new Error('Logout failed')
}
