// A browser-local hint to prevent accidental creation of a second vault.
// Never send this history to the server or use it as proof of identity.
const PREFIX = 'linger_passkey_registered_v1:'

async function historyKey(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${PREFIX}${email.trim().toLowerCase()}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return PREFIX + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hasRegisteredPasskey(email: string): Promise<boolean> {
  try { return localStorage.getItem(await historyKey(email)) === '1' }
  catch { return false }
}

export async function rememberPasskeyRegistration(email: string): Promise<void> {
  if (!email.trim()) return
  try { localStorage.setItem(await historyKey(email), '1') }
  catch { /* Unavailable browser storage must not prevent sign-in or recovery. */ }
}
