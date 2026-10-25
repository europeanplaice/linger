/** Keep OAuth redirects on this origin, including after URL normalization. */
export function sanitizeReturnPath(value: unknown, sessionDomain: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'

  try {
    const origin = new URL(sessionDomain).origin
    const url = new URL(value, origin)
    if (url.origin !== origin) return '/'

    // Dot segments can turn a local path into //host. Recheck the serialized
    // path because Location interprets a leading // as a new authority.
    const path = `${url.pathname}${url.search}${url.hash}`
    return path.startsWith('//') ? '/' : path
  } catch {
    return '/'
  }
}
