import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deploymentOrigin, verifyAsset } from './verify-pages-deployment.mjs'

async function withAsset(content, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'linger-pages-verify-'))
  const absolutePath = join(directory, 'home.html')
  await writeFile(absolutePath, content)

  try {
    await callback({ absolutePath, relativePath: 'home.html' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('accepts the Pages deployment URL returned by Wrangler for the configured project', () => {
  const url = 'https://f7cd342e.grass-puffer.pages.dev'

  assert.equal(deploymentOrigin(url, url).origin, url)
})

test('scheduled audits validate and use the Pages API deployment URL', () => {
  const url = 'https://f7cd342e.grass-puffer.pages.dev'
  assert.equal(deploymentOrigin(url).origin, url)
  assert.throws(() => deploymentOrigin('https://example.com'), /not a valid Cloudflare Pages deployment URL/)
})

test('rejects a Pages API URL that differs from the URL returned by Wrangler', () => {
  assert.throws(
    () => deploymentOrigin(
      'https://f7cd342e.grass-puffer.pages.dev',
      'https://another-id.grass-puffer.pages.dev',
    ),
    /does not match Wrangler deployment URL/,
  )
})

test('rejects deployment URLs outside the Cloudflare Pages domain', () => {
  assert.throws(
    () => deploymentOrigin('https://example.com', 'https://example.com'),
    /not a valid Cloudflare Pages deployment URL/,
  )
})

test('verifies asset bytes after a same-origin Pages clean-URL redirect', async () => {
  const originalFetch = globalThis.fetch
  const deploymentUrl = new URL('https://preview.linger-staging.pages.dev')
  const requestedPaths = []
  const assetContent = Buffer.from('<title>Staging home</title>')

  globalThis.fetch = async (url, options) => {
    requestedPaths.push(new URL(url).pathname)
    assert.equal(options.redirect, 'manual')
    if (requestedPaths.length === 1) {
      return new Response(null, { status: 308, headers: { location: '/home' } })
    }
    return new Response(assetContent, { status: 200 })
  }

  try {
    await withAsset(assetContent, (asset) => verifyAsset(deploymentUrl, asset))
    assert.deepEqual(requestedPaths, ['/home.html', '/home'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('retries a temporarily unavailable asset and verifies its bytes', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => ++requests === 1
    ? new Response(null, { status: 404 })
    : new Response('expected bytes')

  try {
    await withAsset('expected bytes', (asset) => verifyAsset(new URL('https://preview.example.pages.dev'), asset))
    assert.equal(requests, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects an asset redirect outside the Pages deployment origin', async () => {
  const originalFetch = globalThis.fetch
  const deploymentUrl = new URL('https://preview.linger-staging.pages.dev')

  globalThis.fetch = async () => new Response(null, {
    status: 308,
    headers: { location: 'https://example.com/home' },
  })

  try {
    await withAsset('expected bytes', async (asset) => {
      await assert.rejects(
        verifyAsset(deploymentUrl, asset),
        /redirected outside its Pages origin/,
      )
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('verifies the configured Pages Analytics injection while rejecting other byte changes', async (t) => {
  const originalFetch = globalThis.fetch
  const deploymentUrl = new URL('https://preview.example.pages.dev')
  const token = '0123456789abcdef0123456789abcdef'
  const source = '<!doctype html><html><body>Home</body></html>'
  // Captured format from an actual Pages response; keep this independent of
  // the verifier's template so changes to the accepted injection are reviewed.
  const beacon = '<!-- Cloudflare Pages Analytics --><script defer src=\'https://static.cloudflareinsights.com/beacon.min.js\' data-cf-beacon=\'{"token": "0123456789abcdef0123456789abcdef"}\'></script><!-- Cloudflare Pages Analytics -->'
  const injected = source.replace('</body>', `${beacon}</body>`)
  const cases = [
    { name: 'original bytes still match', served: source, config: { web_analytics_token: token }, accepted: true },
    { name: 'exact injection matches project metadata', served: injected, config: { web_analytics_token: token }, accepted: true },
    { name: 'missing project token', served: injected, config: {} },
    { name: 'different project token', served: injected, config: { web_analytics_token: 'f'.repeat(32) } },
    { name: 'changed page content', served: injected.replace('Home', 'Changed'), config: { web_analytics_token: token } },
    { name: 'changed beacon source', served: injected.replace('static.cloudflareinsights.com', 'example.com'), config: { web_analytics_token: token } },
    { name: 'additional script attributes', served: injected.replace('<script defer', '<script onload="alert(1)" defer'), config: { web_analytics_token: token } },
    { name: 'duplicate beacon', served: injected.replace('</body>', `${beacon}</body>`), config: { web_analytics_token: token } },
    { name: 'injection at a different location', served: source.replace('Home', `${beacon}Home`), config: { web_analytics_token: token } },
    { name: 'non-HTML content type', served: injected, config: { web_analytics_token: token }, contentType: 'text/plain' },
    { name: 'non-HTML asset', served: injected, config: { web_analytics_token: token }, relativePath: 'asset.js' },
  ]

  try {
    for (const example of cases) {
      await t.test(example.name, async () => {
        globalThis.fetch = async () => new Response(example.served, {
          headers: { 'content-type': example.contentType ?? 'text/html; charset=utf-8' },
        })
        await withAsset(source, async (asset) => {
          if (example.relativePath) asset.relativePath = example.relativePath
          const verification = verifyAsset(deploymentUrl, asset, example.config)
          if (example.accepted) await verification
          else await assert.rejects(verification, /SHA-256 mismatch/)
        })
      })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
