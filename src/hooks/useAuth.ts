import { useState, useEffect, useCallback } from 'react'
import { startSignIn, checkSession, revokeSession } from '../api/auth'

export type AuthStatus = 'initializing' | 'signedOut' | 'signedIn'

export interface AuthState {
  status: AuthStatus
  tokenExpired: boolean
  hadSession: boolean
  email: string | null
  googleSub: string | null
  googleClientId: string | null
  signIn: () => void
  signOut: () => void
  handleExpired: () => void
  retryAfterExpired: () => void
}

export function useAuth(): AuthState {
  const [status, setStatus] = useState<AuthStatus>('initializing')
  const [tokenExpired, setTokenExpired] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [googleSub, setGoogleSub] = useState<string | null>(null)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [hadSession] = useState<boolean>(
    () => localStorage.getItem('linger_had_session') === 'true'
  )

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
  }, [])

  const handleExpired = useCallback(() => {
    setTokenExpired(true)
  }, [])

  const retryAfterExpired = useCallback(() => {
    startSignIn()
  }, [])

  return { status, tokenExpired, hadSession, email, googleSub, googleClientId, signIn, signOut, handleExpired, retryAfterExpired }
}
