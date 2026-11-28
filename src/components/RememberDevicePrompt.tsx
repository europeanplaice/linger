import { useId, useState } from 'react'
import { useI18n } from '../i18n'
import { authFeedback } from '../lib/authFeedback'
import { clearTabSession, enableTabSession } from '../lib/tabSession'
import type { RememberDays } from '../lib/tabSession'
import { RememberDeviceChoice } from './RememberDeviceChoice'

export function RememberDevicePrompt({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [days, setDays] = useState<RememberDays>(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const titleId = useId()
  const save = async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      if (days) await enableTabSession(days)
      else await clearTabSession({ clearRemote: true })
      onClose()
    } catch (cause) {
      setSaveError(authFeedback(cause, t.login))
    } finally {
      setSaving(false)
    }
  }
  return <aside className="passkey-remember-prompt" aria-labelledby={titleId}>
    <h2 id={titleId}>{t.login.passkeyRememberPrompt}</h2>
    <RememberDeviceChoice value={days} onChange={setDays} disabled={saving} />
    {saveError && <p role="alert">{saveError}</p>}
    <div className="passkey-gate-actions">
      <button className="settings-copy-btn" type="button" disabled={saving} onClick={() => { void save() }}>
        {saving ? t.common.savingEllipsis : days ? t.common.save : t.login.passkeyRememberOff}
      </button>
      <button className="btn-use-another-account" type="button" disabled={saving} onClick={onClose}>{t.common.close}</button>
    </div>
  </aside>
}
