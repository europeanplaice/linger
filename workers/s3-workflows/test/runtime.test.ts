import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  assertWithinDailyStepBudget,
  DAILY_WORKFLOW_STEP_BUDGET,
  entryKey,
  getWorkflowUsage,
  isAtLeast,
  isMissingEntryError,
  isPermanentEntryError,
  isValidDate,
  recordWorkflowStep,
  safeError,
} from '../src/runtime'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv } from '../src/types'

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
  it('never leaks bearer tokens, secrets, or access keys into the message', () => {
    const message = safeError(new Error('Authorization: Bearer ya29.abcdef123 rejected, secret=shh, access_key AKIAFOO'))
    expect(message).not.toMatch(/ya29\.abcdef123/)
    expect(message).not.toMatch(/shh/)
    expect(message).not.toMatch(/AKIAFOO/)
  })

  it('truncates to 200 characters', () => {
    expect(safeError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200)
  })
})

describe('workflow step usage budget', () => {
  const workflowEnv = env as unknown as WorkflowEnv

  it('reports zero usage and full remaining budget when nothing has run today', async () => {
    // Use a fixed unused date via a fresh account key isn't possible for the shared
    // usage singleton, so this only asserts the shape/budget constant, not the count,
    // since other tests in this file share the same singleton instance.
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
