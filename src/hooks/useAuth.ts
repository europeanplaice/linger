import { useState, useEffect, useCallback, useRef } from 'react'
import { startSignIn, checkSession, revokeSession } from '../api/auth'
import { accountIdentity, announceAccount, getAccountSnapshot, invalidateAccount, readAuthEvent, setActiveAccount, subscribeAccountChanges } from '../lib/accountSession'
import { clearOAuthCredentials } from '../lib/oauthCredentials'
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
  const vaultRevision = useRef(0)
  const vaultOperation = useRef<AbortController | null>(null)
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
      vaultRevision.current++
      vaultOperation.current?.abort()
      vaultOperation.current = null
      clearVaultKey()
      clearTabSession()
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
    restoreTabSession(() => !cancelled && revision === authRevision.current).then(() => checkSession()).then(info => {
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
    const pendingSignIn = startSignIn({ selectAccount: Boolean(options.selectAccount) })
    // Do not retain the previous Google credentials during account switching.
    saveTabSession()
    pendingSignIn.then(info => {
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

  const runVaultAction = useCallback(async (action: 'setup' | 'unlock' | 'add', remember = false) => {
    const revision = ++vaultRevision.current
    vaultOperation.current?.abort()
    const controller = new AbortController()
    vaultOperation.current = controller
    setVaultBusy(true)
    setVaultError(null)
    try {
      if (action === 'setup') {
        const result = await registerPasskey(controller.signal)
        if (revision !== vaultRevision.current) { if (getVaultUserId() === result.userId) clearVaultKey(); return }
        setVaultUserId(result.userId)
      } else if (action === 'unlock') {
        const result = await loginWithPasskey(controller.signal)
        if (revision !== vaultRevision.current) { if (getVaultUserId() === result.userId) clearVaultKey(); return }
        setVaultUserId(result.userId)
      } else if (action === 'add') {
        const userId = getVaultUserId()
        if (!userId) throw new Error('Unlock the vault before adding another passkey')
        await addPasskeyCredential(userId, controller.signal)
        if (revision !== vaultRevision.current) return
      }
      if (action !== 'add') {
        clearTabSession()
        if (remember) { enableTabSession(); saveTabSession() }
      }
      setVaultStatus('unlocked')
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
  }, [])

  const setupPasskey = useCallback((remember = false) => runVaultAction('setup', remember), [runVaultAction])
  const unlockPasskey = useCallback((remember = false) => runVaultAction('unlock', remember), [runVaultAction])
  const addPasskey = useCallback(() => runVaultAction('add'), [runVaultAction])
  const lockVault = useCallback(() => {
    vaultRevision.current++
    vaultOperation.current?.abort()
    vaultOperation.current = null
    clearVaultKey()
    clearTabSession()
    clearOAuthCredentials()
    setVaultUserId(null)
    setVaultStatus('locked')
    setVaultBusy(false)
  }, [])
  const clearVaultError = useCallback(() => setVaultError(null), [])

  const signOut = useCallback(() => {
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

  const retryAfterExpired = useCallback((selectAccount = false) => {
    signIn({ selectAccount, expectedGoogleSub: googleSub })
  }, [googleSub, signIn])

  return { status, tokenExpired, hadSession, email, googleSub, googleClientId, authError, signingIn, clearAuthError, signIn, signOut, handleExpired, retryAfterExpired, vaultStatus, vaultBusy, vaultError, vaultUserId, setupPasskey, unlockPasskey, addPasskey, lockVault, clearVaultError }
}
