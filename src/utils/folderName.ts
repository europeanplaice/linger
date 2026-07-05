// Single source of truth for the environment → Drive folder name mapping,
// used by both the Pages Functions backend (via SESSION_DOMAIN) and the
// browser (via window.location.hostname). Keep this module DOM-free so the
// functions tsconfig (lib: ES2022) can compile it.
const FOLDER_BASE = 'linger_diary'

const DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function folderNameForHostname(hostname: string): string {
  if (hostname.includes('staging.')) {
    return `${FOLDER_BASE}_staging`
  }
  if (DEV_HOSTNAMES.has(hostname)) {
    return `${FOLDER_BASE}_dev`
  }
  return FOLDER_BASE
}

// Accepts a full origin/URL ("https://staging.example.com", "http://localhost:8788")
// or a bare hostname, and reduces it to the hostname before mapping so that
// e.g. "https://localhost.mydomain.com" is NOT treated as a dev environment.
export function folderNameForOrigin(origin?: string): string {
  if (!origin) return FOLDER_BASE
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    try {
      hostname = new URL(`http://${origin}`).hostname
    } catch {
      hostname = origin
    }
  }
  return folderNameForHostname(hostname)
}
