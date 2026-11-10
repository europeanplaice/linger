const STORAGE_KEY = 'linger_remember_device_prompt_dismissed_v1'

export function shouldOfferRememberDevicePrompt(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== 'true' }
  catch { return true }
}

export function rememberDevicePromptDismissal(): void {
  // This records only that the browser's user has answered the prompt. It
  // never enables persistence, saves a key, or renews a device session.
  try { localStorage.setItem(STORAGE_KEY, 'true') }
  catch { /* The current page still remembers dismissal in useAuth. */ }
}
