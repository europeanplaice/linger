import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'
import type { AuthErrorCode, GoogleConnection } from '../hooks/useAuth'
import { authFeedback } from '../lib/authFeedback'

interface Props {
  onReauth: () => void
  onUseAnotherAccount: () => void
  switchBlocked?: boolean
  switchAvailable?: boolean
  signingIn: boolean
  authError: AuthErrorCode | null
  googleConnection?: GoogleConnection
  onRetryConnection?: () => void
  email?: string | null
}

export function SessionExpiredModal({ onReauth, onUseAnotherAccount, switchBlocked, switchAvailable, signingIn, authError, googleConnection, onRetryConnection, email }: Props) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  return (
    <motion.dialog
      ref={dialogRef}
      className="session-expired-dialog"
      aria-labelledby="session-expired-title"
      onCancel={(e) => e.preventDefault()}
      initial={{ opacity: 0, y: 14, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <p id="session-expired-title" className="session-expired-modal-msg">{googleConnection === 'unavailable' ? t.login.googleUnavailable : googleConnection === 'restoring' ? t.login.googleRestoring : t.session.expired}</p>
      {email && <p className="login-account">{t.login.googleAccount}<br /><strong>{email}</strong></p>}
      {authError === 'sign_in_failed' && <p className="session-expired-modal-error" role="alert">{t.session.reLoginFailed}</p>}
      {authError === 'account_mismatch' && <p className="session-expired-modal-error" role="alert">{t.session.accountMismatch}</p>}
      {authError && authError !== 'sign_in_failed' && authError !== 'account_mismatch' && <p role={authError === 'cancelled' ? 'status' : 'alert'}>{authFeedback(authError, t.login)}</p>}
      {switchBlocked && <p className="session-expired-modal-error" role="status">{t.login.accountSwitchBlocked}</p>}
      <button className="btn-reauth" onClick={googleConnection === 'unavailable' ? onRetryConnection : onReauth} disabled={signingIn || googleConnection === 'restoring'}>
        {googleConnection === 'restoring' ? t.login.googleRestoring : googleConnection === 'unavailable' ? t.login.googleRetry : signingIn ? t.session.loggingIn : t.session.logInAgain}
      </button>
      <button className="btn-use-another-account" onClick={onUseAnotherAccount} disabled={signingIn}>
        {t.login.useAnotherAccount}
      </button>
      {switchAvailable && <p className="session-expired-modal-msg">{t.login.switchAccountSignOutHint}</p>}
    </motion.dialog>
  )
}
