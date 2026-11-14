import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { resolvePlaywrightImage } from './resolve-playwright-image.mjs'

const lockFor = (version) => ({ packages: { 'node_modules/playwright-core': { version } } })
const body = JSON.stringify({ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] })
const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
const response = () => new Response(body, { headers: { 'docker-content-digest': digest } })

test('dependency updates select the corresponding official image, pinned to its verified digest', async () => {
  for (const version of ['1.65.1', '1.66.0']) {
    const image = await resolvePlaywrightImage(lockFor(version), async (url, options) => {
      assert.equal(url, `https://mcr.microsoft.com/v2/playwright/manifests/v${version}-noble`)
      assert.equal(options.headers.Accept, 'application/vnd.oci.image.index.v1+json')
      return response()
    })
    assert.equal(image, `mcr.microsoft.com/playwright:v${version}-noble@${digest}`)
  }
})

test('missing or invalid lockfile versions fail before contacting the registry', async () => {
  for (const lock of [{}, lockFor(''), lockFor('^1.65.1'), lockFor('1.65.1\nimage=other')]) {
    await assert.rejects(resolvePlaywrightImage(lock, () => assert.fail('Unexpected fetch')), /version/)
  }
})

test('an unpublished image fails during preparation', async () => {
  await assert.rejects(resolvePlaywrightImage(lockFor('1.65.1'), async () => new Response(null, { status: 404 })), /HTTP 404/)
})

test('missing or incorrect registry digests are rejected', async () => {
  for (const headers of [{}, { 'docker-content-digest': `sha256:${'0'.repeat(64)}` }]) {
    await assert.rejects(resolvePlaywrightImage(lockFor('1.65.1'), async () => new Response(body, { headers })), /checksum mismatch/)
  }
})

test('an image without the runner architecture is rejected', async () => {
  const armBody = JSON.stringify({ manifests: [{ platform: { os: 'linux', architecture: 'arm64' } }] })
  const armDigest = `sha256:${createHash('sha256').update(armBody).digest('hex')}`
  await assert.rejects(resolvePlaywrightImage(lockFor('1.65.1'), async () => new Response(armBody, {
    headers: { 'docker-content-digest': armDigest },
  })), /No Linux amd64 image/)
})
