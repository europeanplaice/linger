// Previous releases saved the unlocked vault key in browser storage. Never
// restore it: removing these records requires no access to diary drafts.
export type RememberDays = 0 | 1 | 7
export type TabSessionRestore = 'restored' | 'missing' | 'unavailable'

export function clearTabSession(): void {
  try { sessionStorage.removeItem('linger_tab_session_v1') } catch { /* Storage may be unavailable. */ }
  try { localStorage.removeItem('linger_device_session_v1') } catch { /* Retry on the next launch. */ }
}

export function getDeviceSessionExpiry(): null { return null }
export function enableTabSession(_days?: 1 | 7): void { clearTabSession() }
export function saveTabSession(): void { clearTabSession() }
export async function restoreTabSession(_isCurrent?: () => boolean): Promise<TabSessionRestore> {
  clearTabSession()
  return 'missing'
}
