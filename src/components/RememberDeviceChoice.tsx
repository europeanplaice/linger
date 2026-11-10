import { useId } from 'react'
import { useI18n } from '../i18n'
import type { RememberDays } from '../lib/tabSession'

export function RememberDeviceChoice({ value, onChange, disabled = false }: { value: RememberDays; onChange: (days: RememberDays) => void; disabled?: boolean }) {
  const { t } = useI18n()
  const helpId = useId()
  return <div className="passkey-device-choice">
    <label className="passkey-remember">
      <input type="checkbox" checked={value !== 0} disabled={disabled} aria-describedby={helpId} onChange={event => onChange(event.target.checked ? 1 : 0)} />
      <span>{t.login.passkeyRememberChoice}</span>
    </label>
    {value !== 0 && <label className="passkey-duration">{t.login.passkeyRememberDuration}
      <select value={value} disabled={disabled} onChange={event => onChange(event.target.value === '7' ? 7 : 1)}>
        <option value="1">{t.login.passkeyRememberOneDay}</option>
        <option value="7">{t.login.passkeyRememberSevenDays}</option>
      </select>
    </label>}
    <p className="passkey-remember-help" id={helpId}>{t.login.passkeyRememberHelp}</p>
  </div>
}
