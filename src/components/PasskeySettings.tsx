import { useState } from 'react'
import { exportVaultRecovery } from '../api/passkeys'
import { useI18n } from '../i18n'

export function PasskeySettings({ busy, error, onAdd }: { busy: boolean; error: string | null; onAdd: () => void }) {
  const { t } = useI18n()
  const [result, setResult] = useState<'saved' | 'failed' | null>(null)
  const saveRecovery = () => {
    try {
      const blob = new Blob([exportVaultRecovery()], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'linger-recovery.json'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setResult('saved')
    } catch { setResult('failed') }
  }
  return <section className="settings-section passkey-settings" aria-labelledby="passkey-settings-title">
    <h4 className="settings-section-title" id="passkey-settings-title">{t.login.passkeyTitle}</h4>
    <p className="settings-section-description">{t.login.passkeyProviderHelp}</p>
    <div className="passkey-gate-actions">
      <button className="settings-copy-btn" type="button" disabled={busy} onClick={onAdd}>{busy ? t.login.passkeyWorking : t.login.passkeyAdd}</button>
      <button className="settings-copy-btn" type="button" disabled={busy} onClick={saveRecovery}>{t.login.passkeyExport}</button>
    </div>
    <p className="settings-about-text">{t.login.passkeyRecoverySecret}</p>
    {error && <p role="alert">{error}</p>}
    {result && <p role={result === 'failed' ? 'alert' : 'status'}>{result === 'saved' ? t.login.passkeyRecoverySaved : t.login.passkeyRecoveryFailed}</p>}
  </section>
}
