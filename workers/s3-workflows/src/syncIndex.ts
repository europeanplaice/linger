import { DurableObject } from 'cloudflare:workers'
import type { BackfillJob, EntrySyncStatus, S3SyncState } from '../../../functions/_shared/s3Workflow'
import type { WorkflowEnv } from './types'

interface JobReservation {
  job: BackfillJob
  created: boolean
}

interface JobRow {
  [key: string]: string | number | null
  job_id: string
  state: string
  total: number
  completed: number
  failed: number
  failed_dates: string
  started_at: string
  finished_at: string | null
  workflow_id: string
  error: string | null
}

interface EntryRow {
  [key: string]: string | number | null
  date: string
  drive_version: string | null
  synced_version: string | null
  state: string
  updated_at: string
  last_error: string | null
}

function isAtLeast(existing: string | undefined, incoming: string | undefined): boolean {
  if (!existing || !incoming) return false
  try {
    return BigInt(existing) >= BigInt(incoming)
  } catch {
    return false
  }
}

function parseFailedDates(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(date => typeof date === 'string') ? parsed : []
  } catch {
    return []
  }
}

// Must exceed the worst-case time a single *live* Workflow step can spend before
// its next DO write (markRunning/recordProgress/finishJob/failJob all bump
// updated_at) — otherwise a step that's still legitimately retrying gets its job
// declared orphaned and failed out from under it while the Workflow instance is
// still going to resume writing. Worst case, per workflow.ts: STEP_TIMEOUT (2 min)
// x (BOOKKEEPING_STEP_RETRIES.limit + 1) attempts plus exponential backoff between
// them — bookkeeping steps are DO-only and effectively instant in practice, but
// this is sized against the theoretical bound, not the common case. 10 minutes
// leaves comfortable margin above that.
const JOB_ORPHAN_TIMEOUT_MS = 10 * 60 * 1000

function isOrphaned(row: JobRow): boolean {
  const lastActiveStr = (row.updated_at as string | null) ?? (row.started_at as string)
  const lastActive = new Date(lastActiveStr).getTime()
  return Number.isFinite(lastActive) && Date.now() - lastActive > JOB_ORPHAN_TIMEOUT_MS
}

export class S3SyncIndex extends DurableObject<WorkflowEnv> {
  constructor(ctx: DurableObjectState, env: WorkflowEnv) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        date TEXT PRIMARY KEY,
        drive_version TEXT,
        synced_version TEXT,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        failed_dates TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        workflow_id TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_started_at_idx ON jobs(started_at);
      CREATE TABLE IF NOT EXISTS processed_batches (
        job_id TEXT NOT NULL,
        batch_key TEXT NOT NULL,
        PRIMARY KEY (job_id, batch_key)
      );
      CREATE TABLE IF NOT EXISTS account_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    try {
      this.ctx.storage.sql.exec('ALTER TABLE jobs ADD COLUMN updated_at TEXT')
    } catch {
      // Column already exists
    }
  }

  private jobFromRow(row: JobRow): BackfillJob {
    return {
      jobId: row.job_id,
      state: row.state as BackfillJob['state'],
      total: row.total,
      completed: row.completed,
      failed: row.failed,
      failedDates: parseFailedDates(row.failed_dates),
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      workflowId: row.workflow_id,
      ...(row.error ? { error: row.error } : {}),
    }
  }

  private findJob(jobId: string): JobRow | null {
    const rows = this.ctx.storage.sql.exec<JobRow>(
      'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE job_id = ?',
      jobId,
    ).toArray()
    return rows[0] ?? null
  }

  startJob(requestId: string, jobId: string, workflowId: string, enabled: boolean, startedAt: string): JobReservation {
    const existingRequest = this.ctx.storage.sql.exec<JobRow>(
      'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE request_id = ?',
      requestId,
    ).toArray()[0]
    if (existingRequest) return { job: this.jobFromRow(existingRequest), created: false }
    if (!enabled) throw new Error('S3 backup is not enabled')

    const active = this.ctx.storage.sql.exec<JobRow>(
      "SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE state IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1",
    ).toArray()[0]
    if (active) {
      if (isOrphaned(active)) {
        this.failJob(active.job_id, 'Job abandoned or superseded', new Date().toISOString())
      } else {
        throw new Error('A backfill is already running')
      }
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (job_id, request_id, state, started_at, updated_at, workflow_id) VALUES (?, ?, 'queued', ?, ?, ?)",
      jobId,
      requestId,
      startedAt,
      null,
      workflowId,
    )
    const row = this.findJob(jobId)
    if (!row) throw new Error('Failed to create backfill job')
    return { job: this.jobFromRow(row), created: true }
  }

  markStartFailed(jobId: string, message: string, finishedAt: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'queued'",
      finishedAt,
      message.slice(0, 200),
      jobId,
    )
  }

  markRunning(jobId: string): void {
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec("UPDATE jobs SET state = 'running', updated_at = ? WHERE job_id = ? AND state = 'queued'", now, jobId)
  }

  setTotal(jobId: string, total: number): void {
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec('UPDATE jobs SET total = MAX(total, ?), updated_at = ? WHERE job_id = ?', total, now, jobId)
  }

  recordProgress(jobId: string, batchKey: string, completed: number, failedDates: string[]): void {
    const inserted = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO processed_batches (job_id, batch_key) VALUES (?, ?)',
      jobId,
      batchKey,
    )
    if (inserted.rowsWritten === 0) return

    const row = this.findJob(jobId)
    if (!row) throw new Error('Backfill job not found')
    const failed = new Set(row.failed_dates ? parseFailedDates(row.failed_dates) : [])
    for (const date of failedDates) failed.add(date)
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET completed = completed + ?, failed = ?, failed_dates = ?, updated_at = ? WHERE job_id = ?',
      completed,
      failed.size,
      JSON.stringify([...failed].sort()),
      now,
      jobId,
    )
  }

  finishJob(jobId: string, finishedAt: string): void {
    const row = this.findJob(jobId)
    if (!row || row.state === 'cancelled') return
    const state = row.failed > 0 ? 'failed' : 'complete'
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET state = ?, finished_at = ?, completed = MAX(completed, total) WHERE job_id = ?',
      state,
      finishedAt,
      jobId,
    )
  }

  failJob(jobId: string, message: string, finishedAt: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state IN ('queued', 'running')",
      finishedAt,
      message.slice(0, 200),
      jobId,
    )
  }

  getJob(jobId?: string): BackfillJob | null {
    let row = jobId
      ? this.findJob(jobId)
      : this.ctx.storage.sql.exec<JobRow>(
        'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs ORDER BY started_at DESC LIMIT 1',
      ).toArray()[0] ?? null
    if (row && (row.state === 'running' || row.state === 'queued') && isOrphaned(row)) {
      this.failJob(row.job_id, 'Job abandoned or superseded', new Date().toISOString())
      row = jobId ? this.findJob(jobId) : this.ctx.storage.sql.exec<JobRow>(
        'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs ORDER BY started_at DESC LIMIT 1',
      ).toArray()[0] ?? null
    }
    return row ? this.jobFromRow(row) : null
  }

  // Guards against a concurrent in-flight job: without this, a caller that resets
  // right before starting a fresh backfill (see resync.ts) could delete an active
  // job's row out from under it, and startJob's own "already running" check
  // (which only looks at what's currently in the jobs table) would then see
  // nothing there and let a second Workflow chain start alongside the still-live
  // first one. DO method calls are serialized against each other, so this
  // check-then-delete is atomic — no separate lock needed.
  resetAllData(): void {
    const active = this.ctx.storage.sql.exec<JobRow>(
      "SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE state IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1",
    ).toArray()[0]
    if (active && !isOrphaned(active)) throw new Error('A backfill is already running')

    this.ctx.storage.sql.exec('DELETE FROM entries')
    this.ctx.storage.sql.exec('DELETE FROM jobs')
    this.ctx.storage.sql.exec('DELETE FROM processed_batches')
  }

  setBackupEnabled(enabled: boolean, resetEntries = false): void {
    if (resetEntries) {
      this.resetAllData()
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO account_config (key, value) VALUES ('enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      enabled ? '1' : '0',
    )
  }

  getBackupEnabled(): boolean | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM account_config WHERE key = 'enabled'",
    ).toArray()[0]
    if (!row) return null
    return row.value === '1'
  }

  // Called only on the single well-known instance returned by usageTrackerStub()
  // (see runtime.ts) — never on a real per-account instance — so this reuses the
  // generic account_config table as a global daily counter rather than needing a
  // second Durable Object class (and the SQLite migration that would require).
  // A single DO instance handles requests one at a time, so this increment can't
  // race across concurrent Workflow steps the way a KV read-modify-write would.
  recordWorkflowStep(date: string): number {
    this.ctx.storage.sql.exec(
      `INSERT INTO account_config (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(account_config.value AS INTEGER) + 1`,
      `usage:${date}`,
    )
    return this.getWorkflowStepUsage(date)
  }

  getWorkflowStepUsage(date: string): number {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      'SELECT value FROM account_config WHERE key = ?',
      `usage:${date}`,
    ).toArray()[0]
    return row ? Number(row.value) : 0
  }

  getEntry(date: string): EntrySyncStatus | null {
    const row = this.ctx.storage.sql.exec<EntryRow>(
      'SELECT date, drive_version, synced_version, state, updated_at, last_error FROM entries WHERE date = ?',
      date,
    ).toArray()[0]
    if (!row) return null
    return {
      date: row.date,
      ...(row.drive_version ? { driveVersion: row.drive_version } : {}),
      ...(row.synced_version ? { syncedVersion: row.synced_version } : {}),
      state: row.state as S3SyncState,
      updatedAt: row.updated_at,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    }
  }

  markPending(date: string, driveVersion: string | undefined, updatedAt: string): EntrySyncStatus | null {
    const current = this.getEntry(date)
    if (current?.driveVersion && driveVersion && isAtLeast(current.driveVersion, driveVersion) && current.driveVersion !== driveVersion) {
      return current
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (date, drive_version, synced_version, state, updated_at, last_error)
       VALUES (?, ?, ?, 'pending', ?, NULL)
       ON CONFLICT(date) DO UPDATE SET drive_version = excluded.drive_version, state = 'pending', updated_at = excluded.updated_at, last_error = NULL
       WHERE entries.drive_version IS NULL OR excluded.drive_version IS NULL OR entries.drive_version = excluded.drive_version OR CAST(excluded.drive_version AS INTEGER) >= CAST(entries.drive_version AS INTEGER)`,
      date,
      driveVersion ?? current?.driveVersion ?? null,
      current?.syncedVersion ?? null,
      updatedAt,
    )
    return this.getEntry(date)
  }

  markSynced(date: string, driveVersion: string | undefined, updatedAt: string): EntrySyncStatus | null {
    const current = this.getEntry(date)
    if (current?.driveVersion && driveVersion && current.driveVersion !== driveVersion && isAtLeast(current.driveVersion, driveVersion)) return current
    const syncedVersion = current?.syncedVersion && driveVersion && isAtLeast(current.syncedVersion, driveVersion)
      ? current.syncedVersion
      : driveVersion ?? current?.syncedVersion
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (date, drive_version, synced_version, state, updated_at, last_error)
       VALUES (?, ?, ?, 'synced', ?, NULL)
       ON CONFLICT(date) DO UPDATE SET drive_version = excluded.drive_version, synced_version = excluded.synced_version, state = 'synced', updated_at = excluded.updated_at, last_error = NULL`,
      date,
      driveVersion ?? current?.driveVersion ?? null,
      syncedVersion ?? null,
      updatedAt,
    )
    return this.getEntry(date)
  }

  markFailed(date: string, driveVersion: string | undefined, error: string, updatedAt: string): EntrySyncStatus | null {
    const current = this.getEntry(date)
    if (current?.driveVersion && driveVersion && current.driveVersion !== driveVersion && isAtLeast(current.driveVersion, driveVersion)) return current
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (date, drive_version, synced_version, state, updated_at, last_error)
       VALUES (?, ?, ?, 'failed', ?, ?)
       ON CONFLICT(date) DO UPDATE SET drive_version = excluded.drive_version, state = 'failed', updated_at = excluded.updated_at, last_error = excluded.last_error`,
      date,
      driveVersion ?? current?.driveVersion ?? null,
      current?.syncedVersion ?? null,
      updatedAt,
      error.slice(0, 200),
    )
    return this.getEntry(date)
  }

  markDeleted(date: string): void {
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE date = ?', date)
  }
}
