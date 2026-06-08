import { describe, expect, it } from 'vitest'
import { onRequest } from '../../functions/_middleware'

const CSP =
  "default-src 'self'; script-src 'self' https://accounts.google.com 'sha256-abc'; style-src 'self' 'unsafe-inline'"

function makeContext(response: Response) {
  return {
    request: new Request('http://localhost/'),
    next: () => Promise.resolve(response),
  }
}

function scriptSrc(csp: string | null): string {
  const m = csp?.match(/script-src ([^;]*)/)
  return m ? m[1] : ''
}

function nonceOf(csp: string | null): string | null {
  const m = csp?.match(/'nonce-([^']+)'/)
  return m ? m[1] : null
}

function htmlResponse(extraInit?: ResponseInit) {
  return new Response('<html>hi</html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP },
    ...extraInit,
  })
}

describe('root CSP nonce middleware', () => {
  it('appends a nonce to script-src on HTML responses', async () => {
    const res = await onRequest(makeContext(htmlResponse()) as never)
    const csp = res.headers.get('Content-Security-Policy')

    expect(nonceOf(csp)).toBeTruthy()
    // existing sources and hashes are preserved
    expect(scriptSrc(csp)).toContain("'self'")
    expect(scriptSrc(csp)).toContain('https://accounts.google.com')
    expect(scriptSrc(csp)).toContain("'sha256-abc'")
    // other directives are left intact
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('uses a fresh, base64-looking nonce per request', async () => {
    const a = await onRequest(makeContext(htmlResponse()) as never)
    const b = await onRequest(makeContext(htmlResponse()) as never)

    const na = nonceOf(a.headers.get('Content-Security-Policy'))
    const nb = nonceOf(b.headers.get('Content-Security-Policy'))

    expect(na).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(na).not.toBe(nb)
  })

  it('passes through non-HTML responses unchanged', async () => {
    const json = new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    const res = await onRequest(makeContext(json) as never)

    expect(res.headers.get('Content-Security-Policy')).toBeNull()
    expect(res.headers.get('Content-Type')).toBe('application/json')
  })

  it('leaves an HTML response without a CSP untouched', async () => {
    const html = new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
    const res = await onRequest(makeContext(html) as never)

    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })

  it('preserves status, statusText and body', async () => {
    const res = await onRequest(
      makeContext(htmlResponse({ status: 201, statusText: 'Created' })) as never,
    )

    expect(res.status).toBe(201)
    expect(res.statusText).toBe('Created')
    expect(await res.text()).toBe('<html>hi</html>')
  })
})
