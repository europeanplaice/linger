import { useSyncExternalStore } from 'react'
import { confirmLegacyUpgrade, getDatabaseNotice, subscribeDatabaseNotice } from '../lib/diaryCache'
import { useI18n } from '../i18n'

export function DatabaseNotice() {
  const notice = useSyncExternalStore(subscribeDatabaseNotice, getDatabaseNotice, () => null)
  const { t } = useI18n()
  if (!notice) return null
  return <div className="database-notice" role="alert">
    {notice === 'confirm-upgrade' ? <>
      <span>{t.app.databaseUpgradeConfirm}</span>{' '}
      <button type="button" onClick={confirmLegacyUpgrade}>{t.app.databaseUpgradeContinue}</button>
    </> : notice === 'blocked' ? t.app.databaseUpgradeBlocked : t.app.databaseVersionChanged}
  </div>
}
