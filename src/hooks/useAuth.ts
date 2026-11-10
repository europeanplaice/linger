import { useState, useEffect, useCallback, useRef } from 'react'
import { startSignIn, checkSession, revokeSession, refreshGoogleCredentials, clearPendingGoogleCredential, hasPendingGoogleCredential } from '../api/auth'
import { accountIdentity, announceAccount, getAccountSnapshot, invalidateAccount, readAuthEvent, setActiveAccount, subscribeAccountChanges } from '../lib/accountSession'
import { clearOAuthCredentials, getOAuthCredentials } from '../lib/oauthCredentials'
import { clearVaultKey, getVaultUserId } from '../lib/passkeyVault'
import { addPasskey as addPasskeyCredential, loginWithPasskey, registerPasskey } from '../api/passkeys'
import { clearTabSession, enableTabSession, restoreTabSession, saveTabSession } from '../lib/tabSession'

export type AuthStatus = 'initializing' | 'signedOut' | 'signedIn'

export type AuthErrorCode = 'sign_in_failed' | 'account_mismatch'

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
  setupPasskey: (remember?: boolean) => Promise<void>
  setupEmail: string | null
  beginSetup: () => void
  cancelSetup: () => void
  unlockPasskey: (remember?: boolean) => Promise<void>
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
  const vaultRevision = useRef(0)
  const vaultOperation = useRef<AbortController | null>(null)
  const authRevision = useRef(0)
  const restoring = useRef(true)
  // Only skip forced consent after a refresh has proved the stored credential works.
  const needsGoogleCredential = useRef(true)

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
    const revision = authRevision.current
    const startedEvent = readAuthEvent()?.id
    restoring.current = true
    restoreTabSession(() => !cancelled && revision === authRevision.current).then(async restored => {
      if (restored) {
        const refreshed = await refreshGoogleCredentials().catch(() => false)
        if (!cancelled && revision === authRevision.current) needsGoogleCredential.current = !refreshed
      }
      return checkSession()
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
      setActiveAccount(account, !info.signedIn)
      if (account) announceAccount(account)
      rememberSession(info.signedIn)
      if (!info.signedIn) {
        clearOAuthCredentials()
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
    const pendingSignIn = startSignIn({ selectAccount: Boolean(options.selectAccount), renew: needsGoogleCredential.current })
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
    }).catch(error => {
      if (revision !== authRevision.current) return
      // Cancelling Google consent does not lose the already-unlocked passkey.
      // Account invalidation and actual vault mismatches clear it separately.
      if (!getVaultUserId()) {
        setVaultUserId(null)
        setVaultStatus('locked')
      }
      setSigningIn(false)
      setAuthError(error instanceof Error && error.message === 'account_mismatch' ? 'account_mismatch' : 'sign_in_failed')
      console.error('Google sign-in failed:', error)
    })
  }, [])

  const beginSetup = useCallback(() => {
    const revision = ++authRevision.current
    restoring.current = false
    setVaultBusy(true)
    setVaultError(null)
    setSetupEmail(null)
    void startSignIn({ setup: true, selectAccount: true }).then(info => {
      if (revision !== authRevision.current) return
      if (!info.email) throw new Error('Google did not return an email address')
      setSetupEmail(info.email)
    }).catch(() => {
      if (revision === authRevision.current) setVaultError('Google sign-in could not be completed')
    }).finally(() => { if (revision === authRevision.current) setVaultBusy(false) })
  }, [])

  const cancelSetup = useCallback(() => {
    authRevision.current++
    clearOAuthCredentials()
    clearPendingGoogleCredential()
    setSetupEmail(null)
    setVaultError(null)
  }, [])

  const runVaultAction = useCallback(async (action: 'setup' | 'unlock' | 'add', remember = false) => {
    const revision = ++vaultRevision.current
    vaultOperation.current?.abort()
    const controller = new AbortController()
    vaultOperation.current = controller
    setVaultBusy(true)
    setVaultError(null)
    try {
      if (action === 'setup') {
        if (!setupEmail) throw new Error('Connect Google before creating a passkey')
        const result = await registerPasskey(controller.signal, setupEmail)
        if (revision !== vaultRevision.current) { if (getVaultUserId() === result.userId) clearVaultKey(); return }
        setVaultUserId(result.userId)
      } else if (action === 'unlock') {
        const result = await loginWithPasskey(controller.signal)
        if (revision !== vaultRevision.current) { if (getVaultUserId() === result.userId) clearVaultKey(); return }
        setVaultUserId(result.userId)
      } else if (action === 'add') {
        const userId = getVaultUserId()
        if (!userId) throw new Error('Unlock the vault before adding another passkey')
        await addPasskeyCredential(userId, controller.signal, email)
        if (revision !== vaultRevision.current) return
      }
      if (action !== 'add') {
        clearTabSession()
        if (remember) { enableTabSession(); saveTabSession() }
      }
      if (action !== 'add') {
        if (action === 'unlock') {
          const refreshed = await refreshGoogleCredentials().catch(() => false)
          if (revision !== vaultRevision.current) return
          needsGoogleCredential.current = !refreshed
        }
        let info = await checkSession()
        if (action === 'setup' && info.signedIn) {
          const refreshed = await refreshGoogleCredentials(true).catch(() => false)
          if (revision !== vaultRevision.current) return
          needsGoogleCredential.current = !refreshed
          info = await checkSession()
          setSetupEmail(null)
        }
        if (revision !== vaultRevision.current) return
        setVaultStatus('unlocked')
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
        const message = error instanceof Error ? error.message : 'Passkey setup could not be completed'
        setVaultError(message)
        if (action !== 'add' && /support|secure connection/i.test(message)) setVaultStatus('unsupported')
      }
    } finally {
      if (vaultOperation.current === controller) vaultOperation.current = null
      if (revision === vaultRevision.current) setVaultBusy(false)
    }
  }, [email, setupEmail])

  const setupPasskey = useCallback((remember = false) => runVaultAction('setup', remember), [runVaultAction])
  const unlockPasskey = useCallback((remember = false) => runVaultAction('unlock', remember), [runVaultAction])
  const addPasskey = useCallback(() => runVaultAction('add'), [runVaultAction])
  const lockVault = useCallback(() => {
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
          schedule()
        } else {
          needsGoogleCredential.current = true
          rejected = true
          handleExpired()
        }
      } catch {
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

  return { status, tokenExpired, hadSession, email, googleSub, googleClientId, authError, signingIn, clearAuthError, signIn, signOut, handleExpired, retryAfterExpired, vaultStatus, vaultBusy, vaultError, vaultUserId, setupPasskey, setupEmail, beginSetup, cancelSetup, unlockPasskey, addPasskey, lockVault, clearVaultError }
}
