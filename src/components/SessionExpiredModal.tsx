import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'

interface Props {
  onReauth: () => void
}

export function SessionExpiredModal({ onReauth }: Props) {
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
      <button className="btn-reauth" onClick={onReauth}>
        {t.session.logInAgain}
      </button>
    </motion.dialog>
  )
}
