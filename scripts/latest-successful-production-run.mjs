import { appendFile } from 'node:fs/promises'

const API_VERSION = '2022-11-28'
const PER_PAGE = 100
const MAX_PAGES = 10

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function listWorkflowRuns(repository, token) {
  const runs = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/deploy.yml/runs`)
    url.searchParams.set('branch', 'main')
    url.searchParams.set('per_page', String(PER_PAGE))
    url.searchParams.set('page', String(page))

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GitHub Actions API returned HTTP ${response.status}`)

    const payload = await response.json()
    if (!Array.isArray(payload.workflow_runs)) throw new Error('GitHub Actions API returned an invalid workflow run list')
    const batch = payload.workflow_runs.filter((run) => run.event === 'push' && run.head_branch === 'main')
    runs.push(...batch)
    if (payload.workflow_runs.length < PER_PAGE) break
  }

  return runs.sort((left, right) => right.run_number - left.run_number)
}

async function writeOutputs(values) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile) throw new Error('GITHUB_OUTPUT is required')
  await appendFile(outputFile, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
}

async function main() {
  const repository = requiredEnv('GITHUB_REPOSITORY')
  const token = requiredEnv('GH_TOKEN')
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must have the owner/repository format')

  const runs = await listWorkflowRuns(repository, token)
  const latestRun = runs[0]
  if (!latestRun) throw new Error('No main-branch push runs were found for deploy.yml')

  const activeRun = runs.find((run) => run.status !== 'completed')
  const latestSuccessfulRun = runs.find((run) => run.status === 'completed' && run.conclusion === 'success')

  if (activeRun && (!latestSuccessfulRun || activeRun.run_number > latestSuccessfulRun.run_number)) {
    await writeOutputs({ skip: 'true' })
    console.log(`Skipping integrity audit while production workflow run #${activeRun.run_number} is ${activeRun.status}`)
    return
  }
  if (!latestSuccessfulRun || !/^[\da-f]{40}$/i.test(latestSuccessfulRun.head_sha)) {
    throw new Error('No successful main-branch production deployment run with a full Git SHA was found')
  }

  await writeOutputs({ sha: latestSuccessfulRun.head_sha, run_id: String(latestSuccessfulRun.id), skip: 'false' })
  console.log(`Auditing Cloudflare against successful production workflow run #${latestSuccessfulRun.run_number} (${latestSuccessfulRun.head_sha})`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unable to resolve the latest successful production run')
  process.exitCode = 1
})
