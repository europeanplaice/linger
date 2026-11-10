import { useId, useState } from 'react'
import { useI18n } from '../i18n'
import { clearTabSession, enableTabSession, saveTabSession } from '../lib/tabSession'
import type { RememberDays } from '../lib/tabSession'
import { RememberDeviceChoice } from './RememberDeviceChoice'

export function RememberDevicePrompt({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [days, setDays] = useState<RememberDays>(0)
  const titleId = useId()
  return <aside className="passkey-remember-prompt" aria-labelledby={titleId}>
    <h2 id={titleId}>{t.login.passkeyRememberPrompt}</h2>
    <RememberDeviceChoice value={days} onChange={setDays} />
    <div className="passkey-gate-actions">
      <button className="settings-copy-btn" type="button" onClick={() => {
        clearTabSession()
        if (days) { enableTabSession(days); saveTabSession() }
        onClose()
      }}>{days ? t.common.save : t.login.passkeyRememberOff}</button>
      <button className="btn-use-another-account" type="button" onClick={onClose}>{t.common.close}</button>
    </div>
  </aside>
}
