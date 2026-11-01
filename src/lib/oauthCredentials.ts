export interface OAuthCredentials {
  accessToken: string
  idToken: string
  expiresAt: number
}

let current: OAuthCredentials | null = null

export function setOAuthCredentials(value: OAuthCredentials): void {
  if (!value.accessToken || !value.idToken || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
    clearOAuthCredentials()
    throw new Error('Google returned invalid or expired credentials')
  }
  current = { ...value }
}

export function getAccessToken(): string | null {
  if (!current || current.expiresAt <= Date.now() + 5_000) {
    clearOAuthCredentials()
    return null
  }
  return current.accessToken
}

export function getIdToken(): string | null {
  return getAccessToken() ? current?.idToken ?? null : null
}

export function clearOAuthCredentials(): void {
  current = null
}
