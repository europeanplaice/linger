import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { S3SyncIndex } from '../src/syncIndex'
import { vaultKey } from './auth'

function stubFor(name: string) {
  return env.S3_SYNC_INDEX.getByName(name)
}

describe('S3SyncIndex protected entry state', () => {
  it('preserves state transitions, rejects stale versions, and deletes encrypted records', async () => {
    const accountKey = 'protected-entry-state'
    const auth = { accountKey, sessionId: 'session', vaultKey: vaultKey() }
    const stub = stubFor(accountKey)
    const date = '2026-01-01'
    const at = '2026-01-01T00:00:00.000Z'
    expect((await stub.updateProtectedEntry(auth, date, 'pending', '100', at))?.state).toBe('pending')
    expect(await stub.updateProtectedEntry(auth, date, 'failed', '100', at, 'S3 write failed')).toMatchObject({ state: 'failed', lastError: 'S3 write failed' })
    expect(await stub.updateProtectedEntry(auth, date, 'synced', '100', at)).toMatchObject({ state: 'synced', syncedVersion: '100' })
    expect((await stub.updateProtectedEntry(auth, date, 'pending', '200', at))?.state).toBe('pending')
    expect(await stub.updateProtectedEntry(auth, date, 'synced', '200', at)).toMatchObject({ state: 'synced', syncedVersion: '200' })
    for (const state of ['pending', 'failed', 'synced'] as const) {
      expect(await stub.updateProtectedEntry(auth, date, state, '100', at)).toMatchObject({ state: 'synced', driveVersion: '200', syncedVersion: '200' })
    }
    await stub.updateProtectedEntry(auth, date, 'deleted')
    expect(await stub.getProtectedEntry(auth, date)).toBeNull()
  })

  it('serializes concurrent updates without regressing the newest version', async () => {
    const accountKey = 'protected-entry-race'
    const auth = { accountKey, sessionId: 'session', vaultKey: vaultKey() }
    const stub = stubFor(accountKey)
    const date = '2026-02-02'
    await Promise.all(['3', '20', '10', '5'].map(version => stub.updateProtectedEntry(auth, date, 'synced', version)))
    expect(await stub.getProtectedEntry(auth, date)).toMatchObject({ driveVersion: '20', syncedVersion: '20' })
  })
})

describe('S3SyncIndex backfill jobs', () => {
  it('creates a job and reports it as queued', async () => {
    const stub = stubFor('account-job-1')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      const reservation = instance.startJob('req-1', 'job-1', 'wf-1', true, '2026-01-01T00:00:00.000Z')
      expect(reservation.created).toBe(true)
      expect(reservation.job.state).toBe('queued')
      expect(reservation.job.jobId).toBe('job-1')
    })
  })

  it('dedups a retried start with the same requestId instead of creating a second job', async () => {
    const stub = stubFor('account-job-2')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      const first = instance.startJob('req-2', 'job-2', 'wf-2', true, '2026-01-01T00:00:00.000Z')
      const retry = instance.startJob('req-2', 'job-3', 'wf-3', true, '2026-01-01T00:00:01.000Z')
      expect(retry.created).toBe(false)
      expect(retry.job.jobId).toBe('job-2')
    })
  })

  it('refuses a second concurrent backfill for the same account', async () => {
    const stub = stubFor('account-job-3')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      // Real "now" timestamps (not a fixed historical string like other tests
      // in this file use) — job-a must be recent enough that isOrphaned's
      // real Date.now() comparison finds it still active, otherwise startJob
      // treats it as abandoned and allows job-b through instead of refusing it.
      instance.startJob('req-a', 'job-a', 'wf-a', true, new Date().toISOString())
      // The throw genuinely happens (confirmed via console output), but
      // vitest-pool-workers' DO dispatch surfaces it as a promise rejection
      // rather than a synchronous throw a plain toThrow() can catch — wrapping
      // in an async fn lets rejects.toThrow() catch it either way.
      await expect(async () => instance.startJob('req-b', 'job-b', 'wf-b', true, new Date().toISOString())).rejects.toThrow('already running')
    })
  })

  it('allows a new backfill once the previous one has finished', async () => {
    const stub = stubFor('account-job-4')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-a', 'job-a', 'wf-a', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-a')
      instance.finishJob('job-a', '2026-01-01T00:00:01.000Z')
      const next = instance.startJob('req-b', 'job-b', 'wf-b', true, '2026-01-01T00:00:02.000Z')
      expect(next.created).toBe(true)
    })
  })

  it('refuses to start a job when backup is not enabled', async () => {
    const stub = stubFor('account-job-5')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      expect(() => instance.startJob('req-c', 'job-c', 'wf-c', false, '2026-01-01T00:00:00.000Z')).toThrow('not enabled')
    })
  })

  it('finishJob marks complete when nothing failed, failed when something did', async () => {
    const okStub = stubFor('account-job-6')
    await runInDurableObject(okStub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-ok', 'job-ok', 'wf-ok', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-ok')
      instance.setTotal('job-ok', 2)
      instance.recordProgress('job-ok', 'batch-0', 2, [])
      instance.finishJob('job-ok', '2026-01-01T00:00:01.000Z')
      expect(instance.getJob('job-ok')?.state).toBe('complete')
    })

    const failStub = stubFor('account-job-7')
    await runInDurableObject(failStub, async (instance: S3SyncIndex, state) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-fail', 'job-fail', 'wf-fail', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-fail')
      instance.setTotal('job-fail', 2)
      expect(() => instance.recordProgress('job-fail', 'batch-0', 1, ['2026-01-05'])).toThrow(/retired/)
      // Historical rows can still be read until an authenticated migration.
      state.storage.sql.exec("UPDATE jobs SET failed = 1, failed_dates = ? WHERE job_id = ?", '["2026-01-05"]', 'job-fail')
      instance.finishJob('job-fail', '2026-01-01T00:00:01.000Z')
      const job = instance.getJob('job-fail')
      expect(job?.state).toBe('failed')
      expect(job?.failedDates).toEqual(['2026-01-05'])
    })
  })

  it('recordProgress is idempotent for a replayed batchKey', async () => {
    const stub = stubFor('account-job-8')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-idem', 'job-idem', 'wf-idem', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-idem')
      instance.setTotal('job-idem', 10)
      instance.recordProgress('job-idem', 'batch-0', 5, [])
      // A Workflow step retry replaying the same batchKey must not double-count.
      instance.recordProgress('job-idem', 'batch-0', 5, [])
      expect(instance.getJob('job-idem')?.completed).toBe(5)
    })
  })

  it('failJob only affects queued/running jobs, not already-finished ones', async () => {
    const stub = stubFor('account-job-9')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-x', 'job-x', 'wf-x', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-x')
      instance.finishJob('job-x', '2026-01-01T00:00:01.000Z')
      instance.failJob('job-x', 'too late', '2026-01-01T00:00:02.000Z')
      expect(instance.getJob('job-x')?.state).toBe('complete')
    })
  })

  it('prunes old completed jobs while keeping recent request deduplication', async () => {
    const stub = stubFor('account-job-retention')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      for (let index = 0; index < 2; index++) {
        const id = `retained-${index}`
        const at = new Date(Date.now() - (index === 0 ? 31 * 86400_000 : 0)).toISOString()
        instance.startJob(`request-${id}`, id, `workflow-${id}`, true, at)
        instance.markRunning(id)
        instance.recordProgress(id, 'batch-0', 1, [])
        instance.finishJob(id, at)
      }
      expect(instance.getJob('retained-0')).toBeNull()
      expect(instance.getJob('retained-1')?.state).toBe('complete')
      expect(instance.startJob('request-retained-1', 'unused', 'unused', true, new Date().toISOString()).created).toBe(false)
      // A replayed old request can no longer return its deleted job row.
      const replay = instance.startJob('request-retained-0', 'replacement', 'replacement-wf', true, new Date().toISOString())
      expect(replay.created).toBe(true)
    })
  })

  it('does not prune a live job while retaining completed history', async () => {
    const stub = stubFor('account-job-retention-active')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      for (let index = 0; index < 101; index++) {
        const id = `finished-${index}`
        const at = new Date(Date.now() + index).toISOString()
        instance.startJob(`request-${id}`, id, `workflow-${id}`, true, at)
        instance.markRunning(id)
        instance.finishJob(id, at)
      }
      instance.startJob('live-request', 'live-job', 'live-wf', true, new Date().toISOString())
      instance.markRunning('live-job')
      expect(instance.getJob('live-job')?.state).toBe('running')
    })
  })
})

describe('S3SyncIndex account isolation', () => {
  it('keeps encrypted entries for different accounts fully separate', async () => {
    const a = { accountKey: 'account-iso-a', sessionId: 'session-a', vaultKey: vaultKey() }
    const b = { accountKey: 'account-iso-b', sessionId: 'session-b', vaultKey: vaultKey() }
    const accountA = stubFor(a.accountKey)
    const accountB = stubFor(b.accountKey)
    await accountA.updateProtectedEntry(a, '2026-01-01', 'synced', '100')
    expect(await accountA.getProtectedEntry(a, '2026-01-01')).toMatchObject({ syncedVersion: '100' })
    expect(await accountB.getProtectedEntry(b, '2026-01-01')).toBeNull()
    expect(await accountB.getBackupEnabled()).toBeNull()
  })
})

describe('S3SyncIndex workflow usage counter', () => {
  // Every test in this block shares the same well-known instance name (see
  // USAGE_TRACKER_KEY in runtime.ts), so each uses its own date to avoid
  // interfering with the others.
  it('starts at zero for a date with no recorded steps', async () => {
    await runInDurableObject(stubFor('__workflow_usage__'), async (instance: S3SyncIndex) => {
      expect(instance.getWorkflowStepUsage('2026-02-01')).toBe(0)
    })
  })

  it('increments once per call and returns the running total', async () => {
    await runInDurableObject(stubFor('__workflow_usage__'), async (instance: S3SyncIndex) => {
      expect(instance.recordWorkflowStep('2026-02-02')).toBe(1)
      expect(instance.recordWorkflowStep('2026-02-02')).toBe(2)
      expect(instance.recordWorkflowStep('2026-02-02')).toBe(3)
      expect(instance.getWorkflowStepUsage('2026-02-02')).toBe(3)
    })
  })

  it('tracks each date independently', async () => {
    await runInDurableObject(stubFor('__workflow_usage__'), async (instance: S3SyncIndex) => {
      instance.recordWorkflowStep('2026-03-01')
      instance.recordWorkflowStep('2026-03-01')
      instance.recordWorkflowStep('2026-03-02')
      expect(instance.getWorkflowStepUsage('2026-03-01')).toBe(2)
      expect(instance.getWorkflowStepUsage('2026-03-02')).toBe(1)
    })
  })
})
