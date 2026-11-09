import { createSession, getSession, saveSession } from '../../../functions/_shared/session'
import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { isAtLeast } from '../../../functions/_shared/s3'
import type { SessionData } from '../../../functions/_shared/session'
import {
  assertWithinDailyStepBudget,
  countedStep,
  DAILY_WORKFLOW_STEP_BUDGET,
  ensureAccountDiaryFolder,
  entryKey,
  entryStatusForAuth,
  getWorkflowUsage,
  isMissingEntryError,
  isPermanentEntryError,
  isValidDate,
  recordWorkflowStep,
  safeError,
} from '../src/runtime'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv } from '../src/types'
import { createTestSession, testSession } from './auth'

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe('entryKey / isValidDate', () => {
  it('builds the plain-text object key for a date', () => {
    expect(entryKey('2026-01-05')).toBe('diary-2026-01-05.txt')
  })

  it('validates YYYY-MM-DD dates only', () => {
    expect(isValidDate('2026-01-05')).toBe(true)
    expect(isValidDate('2026-1-5')).toBe(false)
    expect(isValidDate('not-a-date')).toBe(false)
  })
})

describe('account diary folder coordination', () => {
  it('routes workflow folder lookups through the account DiaryWriter', async () => {
    const accountKey = `folder-account-${crypto.randomUUID()}`
    const sessionId = `folder-session-${crypto.randomUUID()}`
    const original = testSession(accountKey, { access_token: 'access', folder_id: 'old-session-folder' })
    await createTestSession(sessionId, original, env)
    const ensureFolder = vi.fn(async () => {
      const persisted = (await getSession(sessionId, env, original.vault_key))!
      persisted.folder_id = 'canonical-folder'
      await saveSession(sessionId, persisted, env)
      return 'canonical-folder'
    })
    const getByName = vi.fn().mockReturnValue({ ensureFolder })
    const workflowEnv = { DIARY_WRITER: { getByName } } as unknown as WorkflowEnv

    const resolved = await ensureAccountDiaryFolder(workflowEnv, sessionId, original, original.vault_key)

    expect(getByName).toHaveBeenCalledWith(accountKey)
    expect(ensureFolder).toHaveBeenCalledWith({ sessionId, accountKey, accessToken: 'access', expiresAt: original.expires_at, idToken: original.id_token, vaultKey: original.vault_key })
    expect(resolved).toBe('canonical-folder')
    expect(original.folder_id).toBe('canonical-folder')
    expect((await getSession(sessionId, env, original.vault_key))?.folder_id).toBe('canonical-folder')
  })
})

describe('isAtLeast', () => {
  it('compares Drive version numbers as integers, not strings', () => {
    expect(isAtLeast('9', '10')).toBe(false)
    expect(isAtLeast('10', '9')).toBe(true)
    expect(isAtLeast('100', '100')).toBe(true)
  })

  it('treats unparsable versions as not-at-least', () => {
    expect(isAtLeast('abc', '1')).toBe(false)
  })
})

describe('isPermanentEntryError / isMissingEntryError', () => {
  it('treats 4xx (excluding 401/408/409/429) as permanent, entry-specific failures', () => {
    expect(isPermanentEntryError(httpError(400))).toBe(true)
    expect(isPermanentEntryError(httpError(403))).toBe(true)
    expect(isPermanentEntryError(httpError(404))).toBe(true)
  })

  it('treats retryable statuses as not permanent so the batch step retries', () => {
    expect(isPermanentEntryError(httpError(401))).toBe(false)
    expect(isPermanentEntryError(httpError(408))).toBe(false)
    expect(isPermanentEntryError(httpError(409))).toBe(false)
    expect(isPermanentEntryError(httpError(429))).toBe(false)
    expect(isPermanentEntryError(httpError(500))).toBe(false)
  })

  it('treats Drive quota and STS throttling/expiry 4xx bodies as retryable, not permanent', () => {
    expect(isPermanentEntryError(Object.assign(new Error('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'), { status: 403 }))).toBe(false)
    expect(isPermanentEntryError(Object.assign(new Error('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}'), { status: 403 }))).toBe(false)
    expect(isPermanentEntryError(Object.assign(new Error('<Error><Code>ThrottlingException</Code></Error>'), { status: 400 }))).toBe(false)
    expect(isPermanentEntryError(Object.assign(new Error('<Error><Code>ExpiredTokenException</Code></Error>'), { status: 400 }))).toBe(false)
    // A plain 403/400 without one of those signatures stays permanent.
    expect(isPermanentEntryError(Object.assign(new Error('{"error":{"errors":[{"reason":"forbidden"}]}}'), { status: 403 }))).toBe(true)
  })

  it('identifies exactly 404 as a missing entry', () => {
    expect(isMissingEntryError(httpError(404))).toBe(true)
    expect(isMissingEntryError(httpError(403))).toBe(false)
    expect(isMissingEntryError(new Error('no status'))).toBe(false)
  })
})

describe('safeError', () => {
  it('never leaks token, credential, or diary content from the error message', () => {
    const message = safeError(new Error('Authorization: Bearer ya29.abcdef123 secret=shh AKIAFOO diary entry text'))
    expect(message).toBe('Error occurred')
    expect(message).not.toContain('diary entry text')
    const error = new Error('failure')
    error.name = 'diary entry text'
    expect(safeError(error)).toBe('Error occurred')
  })

  it('retains only HTTP status for provider errors', () => {
    expect(safeError({ status: 403, message: 'diary text in provider response' })).toBe('Request failed (HTTP 403)')
  })
})

describe('countedStep error serialization', () => {
  it('sanitizes errors before returning them to Workflow step.do', async () => {
    const leaked = 'diary text Bearer ya29.secret and AWS key AKIASECRET'
    const env = {
      S3_SYNC_INDEX: { getByName: () => ({ recordWorkflowStep: async () => { throw new Error(leaked) } }) },
    }
    const step = { do: (_name: string, fnOrConfig: unknown, maybeFn?: () => Promise<unknown>) =>
      (typeof fnOrConfig === 'function' ? fnOrConfig as () => Promise<unknown> : maybeFn!)() }
    await expect(countedStep(env as never, step as never, 'privacy-test', async () => 'ok'))
      .rejects.toThrow('Error occurred')
  })
})

describe('entryStatusForAuth stale-pending aging', () => {
  // This describe must run *before* the daily-step-budget describe below: the
  // budget one deliberately fills the shared __workflow_usage__ counter up to the
  // daily limit, and the lazy re-arm that this describe's stale tests exercise is
  // gated on that same counter, so running it exhausted would flip their expected
  // 'pending' to a budget refusal 'failed'.
  const workflowEnv = env as unknown as WorkflowEnv

  async function seedPending(accountKey: string, updatedAt: string) {
    const session: SessionData = testSession(accountKey, { access_token: 'a', id_token: 'i' })
    await createTestSession(accountKey, session, env)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      return instance.updateProtectedEntry({ sessionId: accountKey, accountKey, vaultKey: session.vault_key }, '2026-01-01', 'pending', '5', updatedAt)
    })
    return session.vault_key
  }

  it('reports a fresh pending record as pending', async () => {
    const key = await seedPending('stale-fresh-1', new Date().toISOString())
    const status = await entryStatusForAuth(workflowEnv, { sessionId: 'stale-fresh-1', accountKey: 'stale-fresh-1', vaultKey: key, date: '2026-01-01', requestedVersion: '5' })
    expect(status?.status).toBe('pending')
  })

  it('fails closed when a stale record would need a durable mirror re-arm', async () => {
    const key = await seedPending('stale-old-1', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    const create = vi.fn().mockResolvedValue(undefined)
    const workflowEnvWithMock = {
      ...workflowEnv,
      S3_MIRROR_WORKFLOW: { create, get: vi.fn().mockRejectedValue(new Error('not found')) },
    } as unknown as WorkflowEnv
    const status = await entryStatusForAuth(workflowEnvWithMock, {
      sessionId: 'stale-old-1',
      accountKey: 'stale-old-1',
      vaultKey: key,
      date: '2026-01-01',
      requestedVersion: '5',
      since: new Date(Date.now() - 60 * 1000).toISOString(),
    })
    expect(status?.status).toBe('failed')
    expect(status && 'error' in status ? status.error : '').toMatch(/request-scoped Google credentials/i)
    expect(create).not.toHaveBeenCalled()
  })

  it('still reports pending within the save-grace window even if the record itself is old', async () => {
    const key = await seedPending('stale-grace-1', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    const status = await entryStatusForAuth(workflowEnv, {
      sessionId: 'stale-grace-1',
      accountKey: 'stale-grace-1',
      vaultKey: key,
      date: '2026-01-01',
      requestedVersion: '5',
      since: new Date().toISOString(),
    })
    expect(status?.status).toBe('pending')
  })

  it('reports disabled when backup has never been enabled', async () => {
    const accountKey = 'stale-disabled-1'
    const session: SessionData = testSession(accountKey, { access_token: 'a', id_token: 'i' })
    await createTestSession(accountKey, session, env)
    const status = await entryStatusForAuth(workflowEnv, { sessionId: accountKey, accountKey, vaultKey: session.vault_key, date: '2026-01-01', requestedVersion: '5' })
    expect(status.status).toBe('disabled')
  })
})

describe('workflow step usage budget', () => {
  const workflowEnv = env as unknown as WorkflowEnv

  it('reports zero usage and full remaining budget when nothing has run today', async () => {
    // Uses the shared usage singleton, so it only asserts the shape/budget
    // constant, not the absolute count, since other tests share the singleton.
    const usage = await getWorkflowUsage(workflowEnv)
    expect(usage.budget).toBe(DAILY_WORKFLOW_STEP_BUDGET)
    expect(usage.remaining).toBe(usage.budget - usage.steps)
  })

  it('recordWorkflowStep increases the count getWorkflowUsage reports', async () => {
    const before = await getWorkflowUsage(workflowEnv)
    await recordWorkflowStep(workflowEnv)
    const after = await getWorkflowUsage(workflowEnv)
    expect(after.steps).toBe(before.steps + 1)
    expect(after.remaining).toBe(before.remaining - 1)
  })

  it('assertWithinDailyStepBudget throws once the budget is reached', async () => {
    const stub = env.S3_SYNC_INDEX.getByName('__workflow_usage__')
    const today = new Date().toISOString().slice(0, 10)
    await runInDurableObject(stub, (instance: S3SyncIndex) => {
      for (let i = 0; i < DAILY_WORKFLOW_STEP_BUDGET; i += 1) instance.recordWorkflowStep(today)
    })
    await expect(assertWithinDailyStepBudget(workflowEnv)).rejects.toThrow('budget')
  })
})
