import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

async function checkResponse(origin, path, status, timeoutMs) {
  // No cookie jar or redirect following: login redirects and access challenges
  // must fail instead of looking like a healthy, authenticated API.
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.text()
  requireCondition(response.status === status, `${path}: expected HTTP ${status}, received ${response.status}`)
  return { response, body }
}

function checkJson(response, body, path) {
  requireCondition(response.headers.get('content-type')?.includes('application/json'), `${path}: expected JSON content type`)
  requireCondition(/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? ''), `${path}: expected Cache-Control: no-store`)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${path}: invalid JSON`)
  }
}

export async function checkDeployment(baseUrl, { attempts = 6, retryDelayMs = 5000, timeoutMs = 10000 } = {}) {
  const origin = new URL(baseUrl)
  requireCondition(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password, 'Expected an HTTP(S) URL without credentials')
  requireCondition(Number.isInteger(attempts) && attempts > 0, 'Expected at least one attempt')

  const checks = [
    async () => {
      const { response, body } = await checkResponse(origin, '/', 200, timeoutMs)
      requireCondition(response.headers.get('content-type')?.includes('text/html') && /<title>\s*Linger(?:\s[^<]*)?<\/title>/i.test(body), '/: expected the Linger HTML page')
    },
    async () => {
      const { response, body } = await checkResponse(origin, '/auth/session', 200, timeoutMs)
      const data = checkJson(response, body, '/auth/session')
      requireCondition(data?.signedIn === false, '/auth/session: expected signedIn: false without cookies')
    },
    async () => {
      const { response, body } = await checkResponse(origin, '/api/drive/entries', 401, timeoutMs)
      const data = checkJson(response, body, '/api/drive/entries')
      requireCondition(data?.error === 'Unauthorized', '/api/drive/entries: expected an Unauthorized response')
    },
    async () => {
      const { response } = await checkResponse(origin, '/sw.js', 200, timeoutMs)
      requireCondition(/(?:application|text)\/(?:javascript|ecmascript)/i.test(response.headers.get('content-type') ?? ''), '/sw.js: expected JavaScript content type')
      const cacheControl = response.headers.get('cache-control') ?? ''
      requireCondition(/(?:^|,)\s*no-cache\s*(?:,|$)/i.test(cacheControl), '/sw.js: expected Cache-Control: no-cache')
      requireCondition(!/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?[1-9]\d*/i.test(cacheControl), '/sw.js: unexpected positive cache TTL')
    },
  ]

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const results = await Promise.allSettled(checks.map(check => check()))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message)
    if (errors.length === 0) {
      console.log(`Deployment checks passed for ${origin.origin}: /, /auth/session, /api/drive/entries, /sw.js`)
      return
    }
    console.error(`Deployment check ${attempt}/${attempts} failed: ${errors.join('; ')}`)
    if (attempt === attempts) throw new Error(`Deployment checks failed for ${origin.origin}`)
    await setTimeout(retryDelayMs)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireCondition(process.argv.length === 3, 'Usage: node scripts/check-deployment.mjs <base-url>')
    await checkDeployment(process.argv[2])
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
