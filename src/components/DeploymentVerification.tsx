import { useState } from 'react'
import { ExternalLink, LoaderCircle, Shield, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useI18n } from '../i18n'

const AUDIT_WORKFLOW_URL = 'https://api.github.com/repos/europeanplaice/linger/actions/workflows/deployment-integrity.yml/runs?branch=main&event=schedule&per_page=1'
const GITHUB_REPO_URL = 'https://github.com/europeanplaice/linger'
const GITHUB_API_REPO_URL = 'https://api.github.com/repos/europeanplaice/linger'
const AUDIT_HISTORY_PAGE_URL = `${GITHUB_REPO_URL}/actions/workflows/deployment-integrity.yml?query=branch%3Amain`
const MAX_AUDIT_AGE_MS = 90 * 60 * 1000
const FULL_SHA_PATTERN = /^[\da-f]{40}$/i
const BUILD_SHA = __DEPLOY_VERSION__
const BUILD_BRANCH = __DEPLOY_BRANCH__
const BUILD_COMMIT_URL = __DEPLOY_COMMIT_URL__
const BUILD_AUDIT_HISTORY_URL = __DEPLOY_AUDIT_HISTORY_URL__

type VerificationState =
  | { kind: 'idle' | 'loading' | 'pending' | 'verified' | 'failed' | 'not-verified' | 'stale' | 'unavailable' | 'dev-build' | 'non-production'; runId?: number; checkedAt?: string; auditedSha?: string }

type AuditRun = {
  id: number
  event: string
  head_branch: string
  status: string
  conclusion: string | null
}

type VerifyJob = {
  name: string
  status: string
  conclusion: string | null
  completed_at: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function fetchGitHubJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
  return response.json()
}

function formatCheckedAt(value: string, language: 'en' | 'ja'): string | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const locale = language === 'ja' ? 'ja-JP' : 'en-GB'
  return `${new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)} UTC`
}

export function DeploymentVerification() {
  const { t, language } = useI18n()
  const [state, setState] = useState<VerificationState>(() => ({
    kind: !FULL_SHA_PATTERN.test(BUILD_SHA)
      ? 'dev-build'
      : BUILD_BRANCH === 'main'
        ? 'idle'
        : 'non-production',
  }))
  const buildSha = BUILD_SHA
  const hasBuildSha = FULL_SHA_PATTERN.test(buildSha)
  const buildCommitUrl = hasBuildSha && BUILD_COMMIT_URL === `${GITHUB_REPO_URL}/commit/${buildSha}`
    ? BUILD_COMMIT_URL
    : null
  const auditHistoryUrl = state.runId
    ? `${GITHUB_REPO_URL}/actions/runs/${state.runId}`
    : BUILD_AUDIT_HISTORY_URL === AUDIT_HISTORY_PAGE_URL
      ? BUILD_AUDIT_HISTORY_URL
      : null
  const isProductionBuild = hasBuildSha && BUILD_BRANCH === 'main'
  const shortBuildSha = hasBuildSha ? buildSha.slice(0, 7) : buildSha
  const buildLabel = <>{t.settings.deploymentBuild}: <code>{shortBuildSha}</code></>

  async function checkDeployment() {
    if (!hasBuildSha) {
      setState({ kind: 'dev-build' })
      return
    }
    if (BUILD_BRANCH !== 'main') {
      setState({ kind: 'non-production' })
      return
    }

    setState({ kind: 'loading' })

    try {
      const runPayload = await fetchGitHubJson(AUDIT_WORKFLOW_URL)
      const workflowRuns = isRecord(runPayload) && Array.isArray(runPayload.workflow_runs)
        ? runPayload.workflow_runs
        : []
      const runValue = workflowRuns.find((value): value is Record<string, unknown> =>
        isRecord(value) && value.event === 'schedule' && value.head_branch === 'main',
      )
      if (!runValue || !Number.isSafeInteger(runValue.id) || typeof runValue.status !== 'string') {
        setState({ kind: 'not-verified' })
        return
      }

      const run: AuditRun = {
        id: runValue.id as number,
        event: String(runValue.event ?? ''),
        head_branch: String(runValue.head_branch ?? ''),
        status: runValue.status,
        conclusion: typeof runValue.conclusion === 'string' ? runValue.conclusion : null,
      }
      if (run.status !== 'completed') {
        setState({ kind: 'pending', runId: run.id })
        return
      }
      if (run.conclusion !== 'success') {
        setState({ kind: 'failed', runId: run.id })
        return
      }

      const jobsPayload = await fetchGitHubJson(
        `${GITHUB_API_REPO_URL}/actions/runs/${run.id}/jobs?per_page=100`,
      )
      const jobValues = isRecord(jobsPayload) && Array.isArray(jobsPayload.jobs)
        ? jobsPayload.jobs
        : []
      const jobs = jobValues.filter((value): value is Record<string, unknown> => isRecord(value))
      const verifyJob = jobs.find((job): job is Record<string, unknown> =>
        typeof job.name === 'string' && /^Verify production deployment [\da-f]{40}$/i.test(job.name),
      )
      if (!verifyJob || typeof verifyJob.name !== 'string') {
        setState({ kind: 'not-verified', runId: run.id })
        return
      }

      const auditedSha = verifyJob.name.slice('Verify production deployment '.length)
      const job: VerifyJob = {
        name: verifyJob.name,
        status: typeof verifyJob.status === 'string' ? verifyJob.status : '',
        conclusion: typeof verifyJob.conclusion === 'string' ? verifyJob.conclusion : null,
        completed_at: typeof verifyJob.completed_at === 'string' ? verifyJob.completed_at : null,
      }
      if (job.status !== 'completed') {
        setState({ kind: 'pending', runId: run.id, auditedSha })
        return
      }
      if (job.conclusion !== 'success') {
        setState({ kind: 'failed', runId: run.id, auditedSha })
        return
      }
      if (auditedSha.toLowerCase() !== buildSha.toLowerCase()) {
        setState({ kind: 'not-verified', runId: run.id, auditedSha })
        return
      }

      const checkedAt = job.completed_at
      if (!checkedAt) {
        setState({ kind: 'stale', runId: run.id, auditedSha })
        return
      }
      const checkedAtMs = Date.parse(checkedAt)
      if (!Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > MAX_AUDIT_AGE_MS || checkedAtMs > Date.now()) {
        setState({ kind: 'stale', runId: run.id, auditedSha })
        return
      }

      setState({ kind: 'verified', runId: run.id, auditedSha, checkedAt })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }

  const statusMessage = (() => {
    switch (state.kind) {
      case 'idle': return t.settings.deploymentCheckHelp
      case 'loading': return t.settings.deploymentChecking
      case 'pending': return t.settings.deploymentPending
      case 'verified': {
        const checkedAt = state.checkedAt ? formatCheckedAt(state.checkedAt, language) : null
        return checkedAt ? t.settings.deploymentVerified(shortBuildSha, checkedAt) : t.settings.deploymentNotVerified
      }
      case 'failed': return t.settings.deploymentFailed
      case 'not-verified': return state.auditedSha
        ? t.settings.deploymentMismatch(state.auditedSha.slice(0, 7))
        : t.settings.deploymentNotVerified
      case 'stale': return t.settings.deploymentStale
      case 'dev-build': return t.settings.deploymentDevBuild
      case 'non-production': return t.settings.deploymentNonProduction
      case 'unavailable': return t.settings.deploymentUnavailable
      default: return ''
    }
  })()

  const verificationIcon = state.kind === 'verified'
    ? <ShieldCheck aria-hidden="true" />
    : state.kind === 'failed'
      ? <ShieldAlert aria-hidden="true" />
      : state.kind === 'loading' || state.kind === 'pending'
        ? <LoaderCircle aria-hidden="true" />
        : <Shield aria-hidden="true" />

  return (
    <div className={`deployment-verification deployment-verification--${state.kind}`}>
      <div className="deployment-verification-mark" aria-hidden="true">{verificationIcon}</div>
      <div className="deployment-verification-content">
        <p className="deployment-verification-title">{t.settings.deploymentChecks}</p>
        {buildCommitUrl ? (
          <a
            className="deployment-verification-build"
            href={buildCommitUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {buildLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : (
          <span className="deployment-verification-build">{buildLabel}</span>
        )}
        <p className="deployment-verification-status" role="status" aria-live="polite" aria-atomic="true">
          {statusMessage}
        </p>
        <p className="deployment-verification-scope">{t.settings.deploymentScope}</p>
        {auditHistoryUrl && (
          <a className="deployment-verification-run" href={auditHistoryUrl} target="_blank" rel="noopener noreferrer">
            {state.runId ? t.settings.deploymentViewRun : t.settings.deploymentViewHistory}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
      <button
        className="deployment-verification-button"
        type="button"
        onClick={() => { void checkDeployment() }}
        disabled={!isProductionBuild || state.kind === 'loading'}
        aria-busy={state.kind === 'loading'}
      >
        {state.kind === 'loading' ? t.settings.deploymentCheckingButton : t.settings.deploymentCheckButton}
      </button>
    </div>
  )
}
