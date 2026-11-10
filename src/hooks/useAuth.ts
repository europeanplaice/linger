import { useState, useEffect, useCallback, useRef } from 'react'
import { startSignIn, checkSession, revokeSession, refreshGoogleCredentials, clearPendingGoogleCredential, hasPendingGoogleCredential } from '../api/auth'
import { accountIdentity, announceAccount, getAccountSnapshot, invalidateAccount, readAuthEvent, setActiveAccount, subscribeAccountChanges } from '../lib/accountSession'
import { clearOAuthCredentials, getOAuthCredentials } from '../lib/oauthCredentials'
import { clearVaultKey, getVaultUserId } from '../lib/passkeyVault'
import { addPasskey as addPasskeyCredential, loginWithPasskey, registerPasskey } from '../api/passkeys'
import { clearTabSession, enableTabSession, restoreTabSession, saveTabSession } from '../lib/tabSession'
import type { RememberDays } from '../lib/tabSession'
import { rememberDevicePromptDismissal, shouldOfferRememberDevicePrompt } from '../lib/rememberDevicePrompt'
import { authFeedbackCode } from '../lib/authFeedback'
import type { PasskeyPhase } from '../lib/authFeedback'
import { hasRegisteredPasskey } from '../lib/passkeyRegistrationHistory'

export type AuthStatus = 'initializing' | 'signedOut' | 'signedIn'

export type AuthErrorCode = 'sign_in_failed' | 'account_mismatch' | 'cancelled' | 'network' | 'popup_blocked'
export type GoogleConnection = 'idle' | 'restoring' | 'unavailable' | 'required'

interface SignInOptions {
  selectAccount?: boolean
  expectedGoogleSub?: string | null
}

export interface AuthState {
  status: AuthStatus
  tokenExpired: boolean
  hadSession: boolean
  email: string | null
  googleSub: string | null
  googleClientId: string | null
  authError: AuthErrorCode | null
  signingIn: boolean
  clearAuthError: () => void
  signIn: (options?: SignInOptions) => void
  signOut: () => void
  handleExpired: () => void
  retryAfterExpired: (selectAccount?: boolean) => void
  vaultStatus: 'locked' | 'unlocked' | 'unsupported'
  vaultBusy: boolean
  vaultError: string | null
  vaultUserId: string | null
  vaultPhase: PasskeyPhase | null
  googleConnection: GoogleConnection
  retryGoogleConnection: () => Promise<void>
  offerRememberDevice: boolean
  dismissRememberDevice: () => void
  setupPasskey: (remember?: RememberDays, recovery?: boolean) => Promise<void>
  setupEmail: string | null
  beginSetup: (recovery?: boolean) => void
  cancelSetup: () => void
  unlockPasskey: (remember?: RememberDays, preferImmediate?: boolean) => Promise<void>
  addPasskey: () => Promise<void>
  lockVault: () => void
  clearVaultError: () => void
}

const KNOWN_AUTH_ERROR_CODES: readonly AuthErrorCode[] = ['sign_in_failed', 'account_mismatch']

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
  const [signingIn, setSigningIn] = useState(false)
  const [vaultStatus, setVaultStatus] = useState<'locked' | 'unlocked' | 'unsupported'>('locked')
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [vaultUserId, setVaultUserId] = useState<string | null>(null)
  const [setupEmail, setSetupEmail] = useState<string | null>(null)
  const [vaultPhase, setVaultPhase] = useState<PasskeyPhase | null>(null)
  const [googleConnection, setGoogleConnection] = useState<GoogleConnection>('idle')
  const [offerRememberDevice, setOfferRememberDevice] = useState(false)
  const rememberDevicePromptDismissed = useRef(false)
  const dismissRememberDevice = useCallback(() => {
    rememberDevicePromptDismissed.current = true
    rememberDevicePromptDismissal()
    setOfferRememberDevice(false)
  }, [])
  const offerRememberDeviceChoice = useCallback((remember: RememberDays) => {
    setOfferRememberDevice(!remember && !rememberDevicePromptDismissed.current && shouldOfferRememberDevicePrompt())
  }, [])
  const googleRetryInFlight = useRef(false)
  const vaultRevision = useRef(0)
  const vaultOperation = useRef<AbortController | null>(null)
  const authRevision = useRef(0)
  const restoring = useRef(true)
  // Only skip forced consent after a refresh has proved the stored credential works.
  const needsGoogleCredential = useRef(true)

  const retryGoogleConnection = useCallback(async () => {
    const userId = getVaultUserId()
    if (!userId || googleRetryInFlight.current) return
    googleRetryInFlight.current = true
    const authVersion = authRevision.current
    const vaultVersion = vaultRevision.current
    const isCurrent = () => {
      if (authVersion !== authRevision.current || vaultVersion !== vaultRevision.current) return false
      if (userId === getVaultUserId()) return true
      if (!getVaultUserId()) {
        clearTabSession()
        setVaultUserId(null)
        setVaultStatus('locked')
        setStatus('signedOut')
        setGoogleConnection('idle')
      }
      return false
    }
    setGoogleConnection('restoring')
    try {
      // Setup may have been interrupted before the verified Google identity
      // was linked to the new vault. Complete that step before saving its token.
      if (hasPendingGoogleCredential()) await checkSession({ failOnUnavailable: true })
      if (!isCurrent()) return
      const refreshed = await refreshGoogleCredentials()
      if (!isCurrent()) return
      needsGoogleCredential.current = !refreshed
      const info = await checkSession({ failOnUnavailable: true })
      if (!isCurrent()) return
      setGoogleConnection(info.signedIn ? 'idle' : 'required')
      if (!info.signedIn) return
      const account = accountIdentity(info)
      if (account) { setActiveAccount(account); announceAccount(account) }
      rememberSession(true)
      setEmail(info.email)
      setGoogleSub(info.googleSub)
      setGoogleClientId(info.googleClientId)
      setStatus('signedIn')
      setTokenExpired(false)
    } catch {
      if (isCurrent()) setGoogleConnection('unavailable')
    } finally { googleRetryInFlight.current = false }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeAccountChanges(event => {
      // Initial session restoration checks the event again after the response;
      // two tabs restoring the same account must not sign each other out.
      if (restoring.current && event.account !== null) return
      if (event.account === null || event.account !== getAccountSnapshot().account) invalidateAccount()
    }, () => {
      authRevision.current++
      needsGoogleCredential.current = true
      restoring.current = false
      rememberSession(false)
      vaultRevision.current++
      vaultOperation.current?.abort()
      vaultOperation.current = null
      clearVaultKey()
      clearTabSession()
      clearPendingGoogleCredential()
      setVaultUserId(null)
      setVaultStatus('locked')
      setVaultBusy(false)
      setStatus('signedOut')
      setTokenExpired(false)
      setAuthError(null)
      setSigningIn(false)
      setGoogleConnection('idle')
      setVaultPhase(null)
      setOfferRememberDevice(false)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const clearOnPageExit = () => {
      vaultOperation.current?.abort()
      vaultOperation.current = null
      clearVaultKey()
      clearOAuthCredentials()
      clearPendingGoogleCredential()
    }
    const resetAfterHistoryRestore = (event: PageTransitionEvent) => {
      // A bfcache restore keeps React state, although pagehide discarded keys.
      // Re-enter the unlock flow instead of leaving an unusable signed-in view.
      if (event.persisted) window.location.reload()
    }
    window.addEventListener('pagehide', clearOnPageExit)
    window.addEventListener('pageshow', resetAfterHistoryRestore)
    return () => {
      window.removeEventListener('pagehide', clearOnPageExit)
      window.removeEventListener('pageshow', resetAfterHistoryRestore)
    }
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
    let connectionUnavailable = false
    const revision = authRevision.current
    const startedEvent = readAuthEvent()?.id
    restoring.current = true
    restoreTabSession(() => !cancelled && revision === authRevision.current).then(async restored => {
      if (restored) {
        try {
          const refreshed = await refreshGoogleCredentials()
          if (!cancelled && revision === authRevision.current) {
            needsGoogleCredential.current = !refreshed
            setGoogleConnection(refreshed ? 'idle' : 'required')
          }
        } catch {
          connectionUnavailable = true
          if (!cancelled && revision === authRevision.current) setGoogleConnection('unavailable')
        }
      }
      return checkSession({ failOnUnavailable: true }).catch(() => {
        connectionUnavailable = true
        if (!cancelled && revision === authRevision.current && getVaultUserId()) setGoogleConnection('unavailable')
        return { signedIn: false, email: null, googleSub: null, googleClientId: null, userId: null }
      })
    }).then(info => {
      if (cancelled || revision !== authRevision.current) return
      const activeVaultUser = getVaultUserId()
      if (activeVaultUser) {
        setVaultUserId(activeVaultUser)
        setVaultStatus('unlocked')
      } else {
        setVaultUserId(null)
        setVaultStatus('locked')
      }
      const account = info.signedIn ? accountIdentity(info) : null
      const latest = readAuthEvent()
      if (latest && latest.id !== startedEvent && latest.account !== account) {
        invalidateAccount()
        return
      }
      restoring.current = false
      setActiveAccount(account, !info.signedIn && !connectionUnavailable)
      if (account) announceAccount(account)
      if (!connectionUnavailable || info.signedIn) rememberSession(info.signedIn)
      if (!info.signedIn) {
        if (!connectionUnavailable) clearOAuthCredentials()
        if (getVaultUserId()) saveTabSession()
        else clearTabSession()
      }
      setStatus(info.signedIn ? 'signedIn' : 'signedOut')
      setEmail(info.email)
      setGoogleSub(info.googleSub)
      setGoogleClientId(info.googleClientId)
    })
    return () => { cancelled = true }
  }, [])

  const signIn = useCallback((options: SignInOptions = {}) => {
    const revision = ++authRevision.current
    restoring.current = false
    setAuthError(null)
    setSigningIn(true)
    const hint = options.expectedGoogleSub ?? googleSub
    const pendingSignIn = startSignIn({ selectAccount: Boolean(options.selectAccount), renew: needsGoogleCredential.current, ...(!options.selectAccount && hint ? { loginHint: hint } : {}) })
    // Do not retain the previous Google credentials during account switching.
    saveTabSession()
    pendingSignIn.then(async info => {
      if (revision !== authRevision.current) return
      const unlockedUserId = getVaultUserId()
      if (info.userId && unlockedUserId && info.userId !== unlockedUserId) {
        clearVaultKey()
        clearTabSession()
        setVaultUserId(null)
        setVaultStatus('locked')
        throw new Error('vault_account_mismatch')
      }
      if (options.expectedGoogleSub !== undefined && info.googleSub !== options.expectedGoogleSub) {
        clearOAuthCredentials()
        clearVaultKey()
        clearTabSession()
        setVaultUserId(null)
        setVaultStatus('locked')
        throw new Error('account_mismatch')
      }
      const account = accountIdentity(info)
      if (!account) throw new Error('Google sign-in did not return an account')
      if (hasPendingGoogleCredential()) {
        const refreshed = await refreshGoogleCredentials(true).catch(() => false)
        if (revision !== authRevision.current) return
        needsGoogleCredential.current = !refreshed
      }
      if (revision !== authRevision.current) return
      setActiveAccount(account, getAccountSnapshot().account !== account)
      announceAccount(account)
      rememberSession(true)
      saveTabSession()
      setEmail(info.email)
      setGoogleSub(info.googleSub)
      setGoogleClientId(info.googleClientId)
      setTokenExpired(false)
      setStatus('signedIn')
      setSigningIn(false)
      setGoogleConnection('idle')
    }).catch(error => {
      if (revision !== authRevision.current) return
      // Cancelling Google consent does not lose the already-unlocked passkey.
      // Account invalidation and actual vault mismatches clear it separately.
      if (!getVaultUserId()) {
        setVaultUserId(null)
        setVaultStatus('locked')
      }
      setSigningIn(false)
      const code = authFeedbackCode(error)
      if (code === 'network' && getVaultUserId()) setGoogleConnection('unavailable')
      setAuthError(['account_mismatch', 'cancelled', 'network', 'popup_blocked'].includes(code) ? code as AuthErrorCode : 'sign_in_failed')
      if (code === 'verification_failed') console.error('Google sign-in failed:', error)
    })
  }, [googleSub])

  const beginSetup = useCallback((recovery = false) => {
    const revision = ++authRevision.current
    restoring.current = false
    setVaultBusy(true)
    setVaultError(null)
    setSetupEmail(null)
    setVaultPhase('google')
    void startSignIn({ setup: true, selectAccount: true }).then(async info => {
      if (revision !== authRevision.current) return
      if (!info.email) throw new Error('Google did not return an email address')
      const registered = !recovery && await hasRegisteredPasskey(info.email)
      if (revision !== authRevision.current) return
      if (registered) {
        clearOAuthCredentials()
        clearPendingGoogleCredential()
        setVaultError('already_registered')
        return
      }
      setSetupEmail(info.email)
    }).catch(error => {
      if (revision === authRevision.current) setVaultError(authFeedbackCode(error))
    }).finally(() => { if (revision === authRevision.current) { setVaultBusy(false); setVaultPhase(null) } })
  }, [])

  const cancelSetup = useCallback(() => {
    authRevision.current++
    clearOAuthCredentials()
    clearPendingGoogleCredential()
    setSetupEmail(null)
    setVaultError(null)
  }, [])

  const runVaultAction = useCallback(async (action: 'setup' | 'unlock' | 'add', remember: RememberDays = 0, preferImmediate = false, recovery = false) => {
    const revision = ++vaultRevision.current
    vaultOperation.current?.abort()
    const controller = new AbortController()
    vaultOperation.current = controller
    setVaultBusy(true)
    setVaultError(null)
    const onPhase = (phase: PasskeyPhase) => { if (revision === vaultRevision.current) setVaultPhase(phase) }
    try {
      if (action === 'setup') {
        if (!setupEmail) throw new Error('Connect Google before creating a passkey')
        const result = await registerPasskey(controller.signal, setupEmail, onPhase, recovery)
        if (revision !== vaultRevision.current) { if (getVaultUserId() === result.userId) clearVaultKey(); return }
        setVaultUserId(result.userId)
      } else if (action === 'unlock') {
        const result = await loginWithPasskey(controller.signal, preferImmediate)
        if (revision !== vaultRevision.current) { if (getVaultUserId() === result.userId) clearVaultKey(); return }
        setVaultUserId(result.userId)
      } else if (action === 'add') {
        const userId = getVaultUserId()
        if (!userId) throw new Error('Unlock the vault before adding another passkey')
        await addPasskeyCredential(userId, controller.signal, email, onPhase)
        if (revision !== vaultRevision.current) return
      }
      if (action !== 'add') {
        clearTabSession()
        if (remember) { enableTabSession(remember); saveTabSession() }
      }
      if (action !== 'add') {
        if (action === 'unlock') {
          onPhase('restore')
          await retryGoogleConnection()
          if (revision !== vaultRevision.current) return
          if (!getVaultUserId()) return
          setVaultStatus('unlocked')
          offerRememberDeviceChoice(remember)
          return
        }
        let info
        try {
          onPhase('restore')
          info = await checkSession({ failOnUnavailable: true })
          if (info.signedIn) {
            const refreshed = await refreshGoogleCredentials(true).catch(() => false)
            if (revision !== vaultRevision.current) return
            needsGoogleCredential.current = !refreshed
            info = await checkSession({ failOnUnavailable: true })
          }
        } catch {
          if (revision === vaultRevision.current) {
            setGoogleConnection('unavailable')
            setVaultStatus('unlocked')
            offerRememberDeviceChoice(remember)
            setSetupEmail(null)
          }
          return
        }
        if (revision !== vaultRevision.current) return
        setSetupEmail(null)
        setVaultStatus('unlocked')
        offerRememberDeviceChoice(remember)
        if (info.signedIn) {
          const account = accountIdentity(info)
          if (account) { setActiveAccount(account); announceAccount(account) }
          rememberSession(true)
          setEmail(info.email)
          setGoogleSub(info.googleSub)
          setGoogleClientId(info.googleClientId)
          setStatus('signedIn')
          setTokenExpired(false)
        }
      } else setVaultStatus('unlocked')
    } catch (error) {
      if (revision === vaultRevision.current) {
        if (action !== 'add') {
          clearVaultKey()
          setVaultUserId(null)
          setVaultStatus('locked')
        }
        const code = authFeedbackCode(error)
        setVaultError(code)
        if (action !== 'add' && code === 'unsupported') setVaultStatus('unsupported')
      }
    } finally {
      if (vaultOperation.current === controller) vaultOperation.current = null
      if (revision === vaultRevision.current) { setVaultBusy(false); setVaultPhase(null) }
    }
  }, [email, setupEmail, retryGoogleConnection, offerRememberDeviceChoice])

  const setupPasskey = useCallback((remember: RememberDays = 0, recovery = false) => runVaultAction('setup', remember, false, recovery), [runVaultAction])
  const unlockPasskey = useCallback((remember: RememberDays = 0, preferImmediate = false) => runVaultAction('unlock', remember, preferImmediate), [runVaultAction])
  const addPasskey = useCallback(() => runVaultAction('add'), [runVaultAction])
  const lockVault = useCallback(() => {
    setOfferRememberDevice(false)
    setGoogleConnection('idle')
    setVaultPhase(null)
    needsGoogleCredential.current = true
    vaultRevision.current++
    vaultOperation.current?.abort()
    vaultOperation.current = null
    clearVaultKey()
    clearTabSession()
    clearOAuthCredentials()
    clearPendingGoogleCredential()
    setSetupEmail(null)
    setVaultUserId(null)
    setVaultStatus('locked')
    setVaultBusy(false)
  }, [])
  const clearVaultError = useCallback(() => setVaultError(null), [])

  const signOut = useCallback(() => {
    setOfferRememberDevice(false)
    setGoogleConnection('idle')
    setVaultPhase(null)
    needsGoogleCredential.current = true
    const account = getAccountSnapshot().account
    revokeSession().then(() => {
      // A delayed logout completion must not clear a newly signed-in account.
      if (getAccountSnapshot().account === null && (!readAuthEvent() || readAuthEvent()?.account === account)) announceAccount(null)
    }).catch(() => {})
    vaultRevision.current++
    vaultOperation.current?.abort()
    vaultOperation.current = null
    clearVaultKey()
    clearTabSession()
    setVaultUserId(null)
    setVaultStatus('locked')
    setVaultBusy(false)
    authRevision.current++
    restoring.current = false
    setActiveAccount(null, true)
    rememberSession(false)
    setStatus('signedOut')
    setTokenExpired(false)
    setAuthError(null)
    setSigningIn(false)
  }, [])

  const handleExpired = useCallback(() => {
    clearOAuthCredentials()
    saveTabSession()
    setTokenExpired(true)
  }, [])

  useEffect(() => {
    if (status !== 'signedOut' || vaultStatus !== 'unlocked' || googleConnection !== 'unavailable') return
    const retry = () => { void retryGoogleConnection() }
    const timer = setTimeout(retry, 30_000)
    window.addEventListener('online', retry)
    return () => { clearTimeout(timer); window.removeEventListener('online', retry) }
  }, [status, vaultStatus, googleConnection, retryGoogleConnection])

  useEffect(() => {
    if (status !== 'signedIn' || vaultStatus !== 'unlocked' || signingIn) return
    let stopped = false
    let inFlight = false
    let rejected = false
    const revision = authRevision.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (stopped || inFlight || rejected || revision !== authRevision.current) return
      clearTimeout(timer)
      inFlight = true
      try {
        const refreshed = await refreshGoogleCredentials()
        if (stopped || revision !== authRevision.current) return
        if (refreshed) {
          needsGoogleCredential.current = false
          setTokenExpired(false)
          setGoogleConnection('idle')
          schedule()
        } else {
          needsGoogleCredential.current = true
          rejected = true
          setGoogleConnection('required')
          handleExpired()
        }
      } catch {
        if (!stopped && revision === authRevision.current) setGoogleConnection('unavailable')
        // A temporary outage does not invalidate the saved Google authorization.
        if (!stopped && revision === authRevision.current) timer = setTimeout(refresh, 30_000)
      } finally { inFlight = false }
    }
    const schedule = () => {
      const credentials = getOAuthCredentials()
      const delay = credentials ? credentials.expiresAt - Date.now() - 60_000 : 1000
      timer = setTimeout(refresh, Math.max(1000, hasPendingGoogleCredential() ? Math.min(30_000, delay) : delay))
    }
    const onOnline = () => { void refresh() }
    window.addEventListener('online', onOnline)
    if (tokenExpired) void refresh()
    else schedule()
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [status, vaultStatus, signingIn, tokenExpired, handleExpired])

  const retryAfterExpired = useCallback((selectAccount = false) => {
    signIn({ selectAccount, expectedGoogleSub: googleSub })
  }, [googleSub, signIn])

  return { status, tokenExpired, hadSession, email, googleSub, googleClientId, authError, signingIn, clearAuthError, signIn, signOut, handleExpired, retryAfterExpired, vaultStatus, vaultBusy, vaultError, vaultUserId, vaultPhase, googleConnection, retryGoogleConnection, offerRememberDevice, dismissRememberDevice, setupPasskey, setupEmail, beginSetup, cancelSetup, unlockPasskey, addPasskey, lockVault, clearVaultError }
}
