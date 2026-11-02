import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CONTROL_FILES = new Set(['.assetsignore', '_headers', '_redirects', '_routes.json', '_worker.js'])
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 15_000

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function describeError(error, seen = new Set(), depth = 0) {
  if (depth >= 4) return 'cause chain truncated'
  if (!(error instanceof Error)) return typeof error === 'string' ? error : String(error)
  if (seen.has(error)) return 'circular cause'
  seen.add(error)

  const code = typeof error.code === 'string' ? ` [${error.code}]` : ''
  const cause = error.cause === undefined
    ? ''
    : `; cause=${describeError(error.cause, seen, depth + 1)}`
  const nestedErrors = Array.isArray(error.errors)
    ? `; errors=[${error.errors.slice(0, 4).map((nested) => describeError(nested, seen, depth + 1)).join(' | ')}]`
    : ''

  return `${error.name}${code}: ${error.message}${cause}${nestedErrors}`
}

async function listStaticFiles(directory, currentDirectory = directory) {
  const entries = await readdir(currentDirectory, { withFileTypes: true })
  const paths = []

  for (const entry of entries) {
    const absolutePath = resolve(currentDirectory, entry.name)
    const relativePath = absolutePath.slice(directory.length + 1).split(sep).join('/')

    if (entry.isDirectory()) {
      paths.push(...await listStaticFiles(directory, absolutePath))
      continue
    }

    if (CONTROL_FILES.has(relativePath)) continue
    const info = await lstat(absolutePath)
    if (!info.isFile()) throw new Error(`Unexpected non-file in deployment directory: ${relativePath}`)
    paths.push({ absolutePath, relativePath })
  }

  return paths
}

async function getProductionDeployments(accountId, projectName, apiToken) {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/pages/projects/${encodeURIComponent(projectName)}/deployments`,
  )
  url.searchParams.set('env', 'production')

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const errors = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => [error.code, error.message].filter(Boolean).join(': ')).join('; ')
      : ''
    const rayId = response.headers.get('cf-ray')
    const mitigation = response.headers.get('cf-mitigated')
    const contentType = response.headers.get('content-type')
    const details = [
      errors || payload === null && `non-JSON response (${contentType ?? 'unknown content type'})`,
      rayId && `cf-ray=${rayId}`,
      mitigation && `cf-mitigated=${mitigation}`,
    ].filter(Boolean).join('; ')
    throw new Error(
      `Cloudflare Pages API returned HTTP ${response.status}${details ? `: ${details}` : ''}`,
    )
  }

  if (!payload?.success || !Array.isArray(payload.result)) {
    throw new Error('Cloudflare Pages API returned an invalid deployment list')
  }

  return payload.result
    .filter((deployment) => deployment.environment === 'production')
    .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on))
}

async function waitForExpectedDeployment({ accountId, projectName, apiToken, expectedSha, expectedBranch, expectedDirty, deployStartedAt }) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let latest

  while (Date.now() < deadline) {
    const deployments = await getProductionDeployments(accountId, projectName, apiToken)
    latest = deployments[0]
    if (latest) {
      const metadata = latest.deployment_trigger?.metadata ?? {}
      const createdAt = Date.parse(latest.created_on)
      const matches =
        metadata.commit_hash?.toLowerCase() === expectedSha.toLowerCase() &&
        metadata.branch === expectedBranch &&
        (expectedDirty === undefined || metadata.commit_dirty === expectedDirty) &&
        Number.isFinite(createdAt) &&
        (deployStartedAt === undefined || createdAt >= deployStartedAt * 1000)

      if (matches && latest.latest_stage?.status === 'success') return latest
      if (matches && ['failure', 'canceled'].includes(latest.latest_stage?.status)) {
        throw new Error(`Cloudflare deployment ${latest.id} ended with status ${latest.latest_stage.status}`)
      }
    }

    await sleep(POLL_INTERVAL_MS)
  }

  const metadata = latest?.deployment_trigger?.metadata ?? {}
  throw new Error(
    `Latest production deployment did not match this GitHub Actions run ` +
    `(expected sha=${expectedSha}, branch=${expectedBranch}, started=${deployStartedAt ?? 'not constrained'}; ` +
    `latest id=${latest?.id ?? 'none'}, sha=${metadata.commit_hash ?? 'none'}, ` +
    `branch=${metadata.branch ?? 'none'}, status=${latest?.latest_stage?.status ?? 'none'})`,
  )
}

function deploymentOrigin(deploymentUrl, projectName) {
  const url = new URL(deploymentUrl)
  const permittedHost = url.hostname === `${projectName}.pages.dev` || url.hostname.endsWith(`.${projectName}.pages.dev`)
  if (url.protocol !== 'https:' || !permittedHost || url.username || url.password) {
    throw new Error(`Cloudflare returned an unexpected Pages deployment URL: ${deploymentUrl}`)
  }
  return url
}

async function verifyAsset(deploymentUrl, asset) {
  const encodedPath = asset.relativePath.split('/').map(encodeURIComponent).join('/')
  const url = new URL(encodedPath, deploymentUrl)
  const [expectedBytes, response] = await Promise.all([
    readFile(asset.absolutePath),
    fetch(url, {
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ])

  if (!response.ok) {
    const redirectLocation = response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null
    const redirectDetails = redirectLocation ? ` redirect to ${redirectLocation}` : ''
    throw new Error(`${asset.relativePath}: deployment returned HTTP ${response.status}${redirectDetails}`)
  }
  const deployedBytes = Buffer.from(await response.arrayBuffer())
  const expectedHash = sha256(expectedBytes)
  const deployedHash = sha256(deployedBytes)
  if (expectedHash !== deployedHash) {
    throw new Error(`${asset.relativePath}: SHA-256 mismatch (build=${expectedHash}, deployed=${deployedHash})`)
  }
}

async function verifyAssets(deployment, projectName, distDirectory) {
  const origin = deploymentOrigin(deployment.url, projectName)
  const files = await listStaticFiles(distDirectory)
  if (files.length === 0) throw new Error(`No static files found in ${distDirectory}`)

  const concurrency = 6
  for (let offset = 0; offset < files.length; offset += concurrency) {
    await Promise.all(files.slice(offset, offset + concurrency).map((file) => verifyAsset(origin, file)))
  }

  return files.length
}

async function main() {
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN')
  const projectName = requiredEnv('PAGES_PROJECT')
  const expectedSha = requiredEnv('EXPECTED_COMMIT_SHA')
  const expectedBranch = requiredEnv('EXPECTED_BRANCH')
  const deployStartedAtValue = process.env.DEPLOY_STARTED_AT?.trim()
  const deployStartedAt = deployStartedAtValue === undefined ? undefined : Number(deployStartedAtValue)
  const expectedDirtyValue = process.env.EXPECTED_COMMIT_DIRTY
  const distDirectory = resolve(process.env.DIST_DIRECTORY ?? 'dist')

  if (!/^[\da-f]{40}$/i.test(expectedSha)) throw new Error('EXPECTED_COMMIT_SHA must be a full Git SHA')
  if (deployStartedAt !== undefined && (!Number.isInteger(deployStartedAt) || deployStartedAt <= 0)) {
    throw new Error('DEPLOY_STARTED_AT must be a Unix timestamp in seconds')
  }
  if (expectedDirtyValue !== undefined && !['true', 'false'].includes(expectedDirtyValue)) {
    throw new Error('EXPECTED_COMMIT_DIRTY must be "true" or "false"')
  }
  if (!(await lstat(distDirectory)).isDirectory()) throw new Error(`Deployment directory is not a directory: ${distDirectory}`)

  const deployment = await waitForExpectedDeployment({
    accountId,
    projectName,
    apiToken,
    expectedSha,
    expectedBranch,
    expectedDirty: expectedDirtyValue === undefined ? undefined : expectedDirtyValue === 'true',
    deployStartedAt,
  })
  const assetCount = await verifyAssets(deployment, projectName, distDirectory)

  console.log(
    `Verified Cloudflare Pages production deployment ${deployment.id}: ` +
    `sha=${expectedSha}, branch=${expectedBranch}, ${assetCount} static assets match ${deployment.url}`,
  )
}

main().catch((error) => {
  console.error(describeError(error))
  process.exitCode = 1
})
