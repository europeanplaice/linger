import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export async function resolvePlaywrightImage(lock, fetchImpl = fetch) {
  const version = lock.packages?.['node_modules/playwright-core']?.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Missing or unsupported playwright-core version in package-lock.json')
  }
  const image = `mcr.microsoft.com/playwright:v${version}-noble`
  const response = await fetchImpl(`https://mcr.microsoft.com/v2/playwright/manifests/v${version}-noble`, {
    // Request OCI bytes: registry format conversion can change the body hash.
    headers: { Accept: 'application/vnd.oci.image.index.v1+json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Cannot resolve ${image}: HTTP ${response.status}`)

  const digest = response.headers.get('docker-content-digest')
  const body = Buffer.from(await response.arrayBuffer())
  const checksum = `sha256:${createHash('sha256').update(body).digest('hex')}`
  if (digest !== checksum) throw new Error(`Registry manifest checksum mismatch for ${image}`)
  const manifest = JSON.parse(body.toString('utf8'))
  if (!manifest.manifests?.some(({ platform }) => platform?.os === 'linux' && platform?.architecture === 'amd64')) {
    throw new Error(`No Linux amd64 image available for ${image}`)
  }
  return `${image}@${digest}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const image = await resolvePlaywrightImage(lock)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `image=${image}\n`)
  console.log(image)
}
