import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'
import type { AuthErrorCode } from '../hooks/useAuth'

interface Props {
  onReauth: () => void
  onUseAnotherAccount: () => void
  switchBlocked?: boolean
  switchAvailable?: boolean
  signingIn: boolean
  authError: AuthErrorCode | null
}

export function SessionExpiredModal({ onReauth, onUseAnotherAccount, switchBlocked, switchAvailable, signingIn, authError }: Props) {
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
      <p id="session-expired-title" className="session-expired-modal-msg">{t.session.expired}</p>
      {authError === 'sign_in_failed' && <p className="session-expired-modal-error" role="alert">{t.session.reLoginFailed}</p>}
      {authError === 'account_mismatch' && <p className="session-expired-modal-error" role="alert">{t.session.accountMismatch}</p>}
      {switchBlocked && <p className="session-expired-modal-error" role="status">{t.login.accountSwitchBlocked}</p>}
      <button className="btn-reauth" onClick={onReauth} disabled={signingIn}>
        {signingIn ? t.session.loggingIn : t.session.logInAgain}
      </button>
      <button className="btn-use-another-account" onClick={onUseAnotherAccount} disabled={signingIn}>
        {t.login.useAnotherAccount}
      </button>
      {switchAvailable && <p className="session-expired-modal-msg">{t.login.switchAccountSignOutHint}</p>}
    </motion.dialog>
  )
}
