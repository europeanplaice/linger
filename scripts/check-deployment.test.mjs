import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDeployment } from './check-deployment.mjs'

const origin = 'https://linger.example'
const options = { attempts: 1, retryDelayMs: 0 }

function healthyResponse(path) {
  if (path === '/') return new Response('<title>Linger — Private diary in your own Google Drive</title>', { headers: { 'Content-Type': 'text/html' } })
  if (path === '/sw.js') return new Response('// service worker', { headers: {
    'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate',
  } })
  const unauthorized = path === '/api/drive/entries'
  return new Response(JSON.stringify(unauthorized ? { error: 'Unauthorized' } : { signedIn: false }), {
    status: unauthorized ? 401 : 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function mockFetch(t, override = () => undefined) {
  return t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers?.Cookie, undefined)
    return override(url.pathname) ?? healthyResponse(url.pathname)
  })
}

test('accepts healthy public responses and the expected unauthenticated 401', async t => {
  const fetch = mockFetch(t)
  await checkDeployment(origin, options)
  assert.equal(fetch.mock.callCount(), 4)
})

test('rejects a 200 challenge page instead of treating it as the app', async t => {
  mockFetch(t, path => path === '/' ? new Response('<title>Just a moment...</title>', {
    headers: { 'Content-Type': 'text/html' },
  }) : undefined)
  await assert.rejects(checkDeployment(origin, options), /Deployment checks failed/)
})

test('rejects redirects and HTML fallbacks on the session endpoint', async t => {
  for (const response of [
    new Response(null, { status: 302, headers: { Location: '/login' } }),
    new Response('<title>Linger</title>', { headers: { 'Content-Type': 'text/html' } }),
  ]) {
    const fetch = mockFetch(t, path => path === '/auth/session' ? response : undefined)
    await assert.rejects(checkDeployment(origin, options), /Deployment checks failed/)
    fetch.mock.restore()
  }
})

test('rejects malformed or signed-in session JSON and cacheable API responses', async t => {
  for (const [body, cacheControl] of [
    ['not json', 'no-store'],
    ['{"signedIn":true}', 'no-store'],
    ['{"signedIn":false}', 'public, max-age=14400'],
  ]) {
    const fetch = mockFetch(t, path => path === '/auth/session' ? new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    }) : undefined)
    await assert.rejects(checkDeployment(origin, options), /Deployment checks failed/)
    fetch.mock.restore()
  }
})

test('rejects an API that exposes entries without authentication', async t => {
  mockFetch(t, path => path === '/api/drive/entries' ? new Response('[]', {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }) : undefined)
  await assert.rejects(checkDeployment(origin, options), /Deployment checks failed/)
})

test('rejects a service worker with an overridden browser TTL', async t => {
  for (const cacheControl of ['max-age=14400', 'no-cache, max-age=14400']) {
    const fetch = mockFetch(t, path => path === '/sw.js' ? new Response('// worker', {
      headers: { 'Content-Type': 'application/javascript', 'Cache-Control': cacheControl },
    }) : undefined)
    await assert.rejects(checkDeployment(origin, options), /Deployment checks failed/)
    fetch.mock.restore()
  }
})

test('retries temporary deployment failures and requires all checks to pass together', async t => {
  let rootRequests = 0
  const fetch = mockFetch(t, path => {
    if (path === '/' && ++rootRequests === 1) return new Response('Unavailable', { status: 503 })
  })
  await checkDeployment(origin, { ...options, attempts: 2 })
  assert.equal(fetch.mock.callCount(), 8)
})

test('bounds retries when the deployment stays unavailable', async t => {
  const fetch = mockFetch(t, () => { throw new Error('Network unavailable') })
  await assert.rejects(checkDeployment(origin, { ...options, attempts: 2 }), /Deployment checks failed/)
  assert.equal(fetch.mock.callCount(), 8)
})
