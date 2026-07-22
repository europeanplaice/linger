import { useState, useEffect, useCallback } from 'react'
import { startSignIn, checkSession, revokeSession } from '../api/auth'

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

export function useAuth(): AuthState {
  const [status, setStatus] = useState<AuthStatus>('initializing')
  const [tokenExpired, setTokenExpired] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [googleSub, setGoogleSub] = useState<string | null>(null)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [hadSession] = useState<boolean>(
    () => localStorage.getItem('linger_had_session') === 'true'
  )
  const [authError, setAuthError] = useState<AuthErrorCode | null>(null)

  // `/auth/callback` redirects here with `?auth_error=<code>` on failure (a real
  // browser navigation, not a fetch) — pick it up once, then scrub it from the
  // URL bar so it doesn't linger across reloads or get shared in a copied link.
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
      setStatus('signedIn')
      setEmail('preview@example.com')
      return
    }
    let cancelled = false
    checkSession().then(info => {
      if (cancelled) return
      localStorage.setItem('linger_had_session', String(info.signedIn))
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
    revokeSession().catch(() => {})
    localStorage.setItem('linger_had_session', 'false')
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
