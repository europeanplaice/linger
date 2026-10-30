import { useState, useEffect, useCallback, useRef } from 'react'
import { startSignIn, checkSession, revokeSession } from '../api/auth'
import { accountIdentity, announceAccount, getAccountSnapshot, invalidateAccount, readAuthEvent, setActiveAccount, subscribeAccountChanges } from '../lib/accountSession'

export type AuthStatus = 'initializing' | 'signedOut' | 'signedIn'

export type AuthErrorCode = 'no_refresh_token'

export interface AuthState {
  status: AuthStatus
  tokenExpired: boolean
  hadSession: boolean
  email: string | null
  googleSub: string | null
  googleClientId: string | null
  authError: AuthErrorCode | null
  clearAuthError: () => void
  signIn: () => void
  signOut: () => void
  handleExpired: () => void
  retryAfterExpired: () => void
}

const KNOWN_AUTH_ERROR_CODES: readonly AuthErrorCode[] = ['no_refresh_token']

function rememberSession(signedIn: boolean): void {
  try { localStorage.setItem('linger_had_session', String(signedIn)) } catch { /* Tracking must not prevent authentication changes. */ }
}

export function useAuth(): AuthState {
  const [status, setStatus] = useState<AuthStatus>('initializing')
  const [tokenExpired, setTokenExpired] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [googleSub, setGoogleSub] = useState<string | null>(null)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [hadSession] = useState<boolean>(
    () => { try { return localStorage.getItem('linger_had_session') === 'true' } catch { return false } }
  )
  const [authError, setAuthError] = useState<AuthErrorCode | null>(null)
  const authRevision = useRef(0)
  const restoring = useRef(true)

  useEffect(() => {
    const unsubscribe = subscribeAccountChanges(event => {
      // Initial session restoration checks the event again after the response;
      // two tabs restoring the same account must not sign each other out.
      if (restoring.current && event.account !== null) return
      if (event.account === null || event.account !== getAccountSnapshot().account) invalidateAccount()
    }, () => {
      authRevision.current++
      restoring.current = false
      rememberSession(false)
      setStatus('signedOut')
      setTokenExpired(false)
      setAuthError(null)
    })
    return unsubscribe
  }, [])

  // Pick up an OAuth failure once and remove it from copied/reloaded URLs.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('auth_error')
    if (!code) return
    if ((KNOWN_AUTH_ERROR_CODES as string[]).includes(code)) {
      setAuthError(code as AuthErrorCode)
    }
    params.delete('auth_error')
    const newSearch = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash)
  }, [])

  const clearAuthError = useCallback(() => {
    setAuthError(null)
  }, [])

  useEffect(() => {
    // Dev-only: ?preview-auth bypasses the session check for local UI work.
    // import.meta.env.DEV is replaced with `false` in production builds so
    // this block is dead code outside the dev server.
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview-auth')) {
      setActiveAccount(accountIdentity({ email: 'preview@example.com' }))
      restoring.current = false
      setStatus('signedIn')
      setEmail('preview@example.com')
      return
    }
    let cancelled = false
    const revision = authRevision.current
    const startedEvent = readAuthEvent()?.id
    restoring.current = true
    checkSession().then(info => {
      if (cancelled || revision !== authRevision.current) return
      const account = info.signedIn ? accountIdentity(info) : null
      const latest = readAuthEvent()
      if (latest && latest.id !== startedEvent && latest.account !== account) {
        invalidateAccount()
        return
      }
      restoring.current = false
      setActiveAccount(account, !info.signedIn)
      if (account) announceAccount(account)
      rememberSession(info.signedIn)
      setStatus(info.signedIn ? 'signedIn' : 'signedOut')
      setEmail(info.email)
      setGoogleSub(info.googleSub)
      setGoogleClientId(info.googleClientId)
    })
    return () => { cancelled = true }
  }, [])

  const signIn = useCallback(() => {
    startSignIn()
  }, [])

  const signOut = useCallback(() => {
    const account = getAccountSnapshot().account
    revokeSession().then(() => {
      // A delayed logout completion must not clear a newly signed-in account.
      if (getAccountSnapshot().account === null && (!readAuthEvent() || readAuthEvent()?.account === account)) announceAccount(null)
    }).catch(() => {})
    authRevision.current++
    restoring.current = false
    setActiveAccount(null, true)
    rememberSession(false)
    setStatus('signedOut')
    setTokenExpired(false)
    setAuthError(null)
  }, [])

  const handleExpired = useCallback(() => {
    setTokenExpired(true)
  }, [])

  const retryAfterExpired = useCallback(() => {
    startSignIn()
  }, [])

  return { status, tokenExpired, hadSession, email, googleSub, googleClientId, authError, clearAuthError, signIn, signOut, handleExpired, retryAfterExpired }
}
