export function startSignIn(returnPath = window.location.pathname + window.location.search + window.location.hash): void {
  window.location.href = `/auth/login?redirect=${encodeURIComponent(returnPath)}`
}

export interface SessionInfo {
  signedIn: boolean
  email: string | null
  googleSub: string | null
}

export async function checkSession(): Promise<SessionInfo> {
  try {
    const resp = await fetch('/auth/session', { credentials: 'include' })
    const data = await resp.json() as { signedIn: boolean; email?: string | null; googleSub?: string | null }
    return { signedIn: Boolean(data.signedIn), email: data.email ?? null, googleSub: data.googleSub ?? null }
  } catch {
    return { signedIn: false, email: null, googleSub: null }
  }
}

export async function revokeSession(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
}
