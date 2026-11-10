export type AuthFeedbackCode = 'cancelled' | 'network' | 'unsupported' | 'popup_blocked' | 'account_mismatch' | 'verification_failed' | 'already_registered'
export type PasskeyPhase = 'google' | 'create' | 'verify' | 'restore'

export class AuthFlowError extends Error {
  constructor(public readonly code: AuthFeedbackCode, message: string) { super(message); this.name = 'AuthFlowError' }
}

export function authFeedbackCode(error: unknown): AuthFeedbackCode {
  if (error instanceof AuthFlowError) return error.code
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (['cancelled', 'network', 'unsupported', 'popup_blocked', 'account_mismatch', 'verification_failed', 'already_registered'].includes(message)) return message as AuthFeedbackCode
  if (name === 'NotAllowedError' || name === 'AbortError' || /cancelled|timed out/i.test(message)) return 'cancelled'
  if (/popup.*blocked/i.test(message)) return 'popup_blocked'
  if (/account.mismatch/i.test(message)) return 'account_mismatch'
  if (/PRF|supported browser|secure connection|not support/i.test(message)) return 'unsupported'
  if (name === 'TypeError' || name === 'NetworkError' || /network|offline|temporarily unavailable/i.test(message)) return 'network'
  return 'verification_failed'
}

interface Messages {
  authCancelled: string; authNetwork: string; passkeyRequired: string
  authPopupBlocked: string; authAccountMismatch: string; authVerificationFailed: string
  passkeyAlreadyRegistered: string
}

export function authFeedback(error: unknown, messages: Messages): string {
  const keys = { cancelled: 'authCancelled', network: 'authNetwork', unsupported: 'passkeyRequired', popup_blocked: 'authPopupBlocked', account_mismatch: 'authAccountMismatch', verification_failed: 'authVerificationFailed', already_registered: 'passkeyAlreadyRegistered' } as const
  return messages[keys[authFeedbackCode(error)]]
}
