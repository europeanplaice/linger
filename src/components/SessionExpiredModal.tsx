import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'
import type { AuthErrorCode, GoogleConnection } from '../hooks/useAuth'
import { authFeedback } from '../lib/authFeedback'

export type AccountSwitchAvailability = 'checking' | 'blocked' | 'unavailable' | 'available'

interface Props {
  onReconnect: () => void
  onUseAnotherAccount: () => void
  accountSwitch: AccountSwitchAvailability
  pendingSave: boolean
  signingIn: boolean
  authError: AuthErrorCode | null
  googleConnection?: GoogleConnection
  email?: string | null
}

export function SessionExpiredModal({ onReconnect, onUseAnotherAccount, accountSwitch, pendingSave, signingIn, authError, googleConnection, email }: Props) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  const switchMessage = accountSwitch === 'available' ? t.login.switchAccountSignOutHint
    : accountSwitch === 'blocked' ? t.login.accountSwitchBlocked
    : accountSwitch === 'checking' ? t.login.accountSwitchChecking
    : t.login.accountSwitchCheckFailed
  const reconnecting = signingIn || googleConnection === 'restoring'

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
      <h2 id="session-expired-title" className="session-expired-modal-msg">{t.session.connectionTitle}</h2>
      <p role="status" className="session-expired-modal-msg">{googleConnection === 'unavailable' ? t.login.googleUnavailable : googleConnection === 'restoring' ? t.login.googleRestoring : t.session.expired}</p>
      {email && <p className="login-account">{t.login.googleAccount}<br /><strong>{email}</strong></p>}
      {authError === 'sign_in_failed' && <p className="session-expired-modal-error" role="alert">{t.session.reLoginFailed}</p>}
      {authError === 'account_mismatch' && <p className="session-expired-modal-error" role="alert">{t.session.accountMismatch}</p>}
      {authError && authError !== 'sign_in_failed' && authError !== 'account_mismatch' && <p role={authError === 'cancelled' ? 'status' : 'alert'}>{authFeedback(authError, t.login)}</p>}
      {pendingSave && <p id="session-pending-save" className="session-expired-modal-msg">{t.session.retrySaveAfterReconnect}</p>}
      <button className="btn-reauth" type="button" onClick={onReconnect} disabled={reconnecting} aria-describedby={pendingSave ? 'session-pending-save' : undefined}>
        {googleConnection === 'unavailable' || googleConnection === 'restoring' ? t.login.googleRetry : signingIn ? t.login.googleConnecting : t.login.googleReconnect}
      </button>
      <p id="session-account-switch" className="session-expired-modal-msg" role="status">{switchMessage}</p>
      <button className="btn-use-another-account" type="button" onClick={onUseAnotherAccount} disabled={reconnecting || accountSwitch !== 'available'} aria-describedby="session-account-switch">
        {t.login.useAnotherAccount}
      </button>
    </motion.dialog>
  )
}
