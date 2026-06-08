// Root middleware: attach a per-request CSP nonce to HTML responses.
//
// Cloudflare Bot Fight Mode (JavaScript Detections) injects an inline script
// (/cdn-cgi/challenge-platform/.../jsd/main.js) whose token changes on every
// request, so it cannot be allow-listed with a static hash. Cloudflare documents
// that when the CSP *response header* carries a script nonce, it stamps that same
// nonce onto the scripts it injects (by parsing the header). So we attach a fresh
// nonce to every HTML response; our own inline scripts keep being allow-listed by
// their build-time hashes (hashes and nonces coexist in script-src).
//
// Non-HTML responses (the JSON /api/* and /auth/* endpoints, static assets) are
// passed through untouched.

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next()

  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('text/html')) return response

  const csp = response.headers.get('Content-Security-Policy')
  // Only touch responses that already define a script-src to extend.
  if (!csp || !/script-src /.test(csp)) return response

  const nonce = randomNonce()
  const withNonce = csp.replace(
    /script-src ([^;]*)/,
    (_match, sources: string) => `script-src ${sources.trim()} 'nonce-${nonce}'`,
  )

  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', withNonce)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
