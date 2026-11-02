import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyAsset } from './verify-pages-deployment.mjs'

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
