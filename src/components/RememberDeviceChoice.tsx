import { useId } from 'react'
import { useI18n } from '../i18n'
import type { RememberDays } from '../lib/tabSession'

const DURATION_OPTIONS: readonly (1 | 7)[] = [1, 7]

export function RememberDeviceChoice({ value, onChange, disabled = false }: { value: RememberDays; onChange: (days: RememberDays) => void; disabled?: boolean }) {
  const { t } = useI18n()
  const durationId = useId()
  const helpId = useId()
  const radioName = useId()
  const enabled = value !== 0

  return (
    <div className="passkey-device-choice">
      <label className="passkey-remember">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          aria-describedby={enabled ? helpId : undefined}
          onChange={event => onChange(event.target.checked ? 1 : 0)}
        />
        <span>{t.login.passkeyRememberChoice}</span>
      </label>
      {enabled && (
        <div className="passkey-remember-details">
          <div className="passkey-duration-row">
            <span className="passkey-duration-label" id={durationId}>{t.login.passkeyRememberDuration}</span>
            <div className="passkey-duration-group" role="radiogroup" aria-labelledby={durationId}>
              {DURATION_OPTIONS.map(days => {
                const selected = value === days
                return (
                  <label key={days} className={`passkey-duration-option${selected ? ' is-selected' : ''}`}>
                    <input
                      type="radio"
                      name={radioName}
                      value={days}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => onChange(days)}
                    />
                    <span>{days === 7 ? t.login.passkeyRememberSevenDays : t.login.passkeyRememberOneDay}</span>
                  </label>
                )
              })}
            </div>
          </div>
          <p className="passkey-remember-note" id={helpId}>{t.login.passkeyRememberShortNote}</p>
        </div>
      )}
    </div>
  )
}
