/**
 * Generation job repository.
 *
 * Every claim/complete statement is guarded so a `done` unit can never be
 * clobbered and a result from a superseded plan is discarded. The partial
 * unique index is the only arbiter of "one active job per rendition".
 */

import { db } from '@/data/db';
import { newId } from '@/lib/id';
import {
  JOB_LEASE_MS,
  type GenerationJobType,
  type GenerationStage,
  type JobRecord,
  type JobStatus,
  type JobUnit,
  type JobUnitStatus,
} from '@/domain/jobs';

type JobRow = {
  id: string;
  type: string;
  payload_json: string | null;
  status: string;
  attempts: number;
  error: string | null;
  rendition_id: string | null;
  stage: string | null;
  progress: number;
  units_done: number;
  units_total: number;
  eta_remaining_ms: number | null;
  eta_low_ms: number | null;
  eta_high_ms: number | null;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  cancel_requested: number;
  script_hash: string | null;
  synth_hash: string | null;
  created_at: number;
  updated_at: number;
};

type UnitRow = {
  id: string;
  job_id: string;
  stage: string;
  ordinal: number;
  status: string;
  input_key: string;
  payload_json: string | null;
  result_json: string | null;
  attempts: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type as GenerationJobType,
    renditionId: row.rendition_id,
    status: row.status as JobStatus,
    stage: row.stage as GenerationStage | null,
    progress: row.progress ?? 0,
    unitsDone: row.units_done ?? 0,
    unitsTotal: row.units_total ?? 0,
    etaRemainingMs: row.eta_remaining_ms,
    etaLowMs: row.eta_low_ms,
    etaHighMs: row.eta_high_ms,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    cancelRequested: row.cancel_requested === 1,
    attempts: row.attempts,
    scriptHash: row.script_hash,
    synthHash: row.synth_hash,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUnit(row: UnitRow): JobUnit {
  return {
    id: row.id,
    jobId: row.job_id,
    stage: row.stage as GenerationStage,
    ordinal: row.ordinal,
    status: row.status as JobUnitStatus,
    inputKey: row.input_key,
    payloadJson: row.payload_json,
    resultJson: row.result_json,
    attempts: row.attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|sqlite_constraint_unique|constraint failed/i.test(message);
}

export async function createJob(input: {
  type: GenerationJobType;
  renditionId: string;
  payload: unknown;
  scriptHash: string;
  synthHash: string;
  unitsTotal: number;
  now: number;
}): Promise<string> {
  const id = newId('job');
  try {
    await db().run(
      `INSERT INTO jobs
         (id, type, payload_json, status, rendition_id, stage, progress, units_done, units_total,
          cancel_requested, script_hash, synth_hash, created_at, updated_at)
       VALUES (?,?,?,'queued',?,NULL,0,0,?,0,?,?,?,?)`,
      [
        id,
        input.type,
        JSON.stringify(input.payload ?? null),
        input.renditionId,
        Math.max(0, Math.round(input.unitsTotal)),
        input.scriptHash,
        input.synthHash,
        input.now,
        input.now,
      ],
    );
    return id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await getActiveJobForRendition(input.renditionId);
    if (existing) return existing.id;
    throw error;
  }
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const row = await db().first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  return row ? mapJob(row) : null;
}

export async function getActiveJobForRendition(renditionId: string): Promise<JobRecord | null> {
  const row = await db().first<JobRow>(
    "SELECT * FROM jobs WHERE rendition_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
    [renditionId],
  );
  return row ? mapJob(row) : null;
}

export async function listJobsForRendition(
  renditionId: string,
  limit = 20,
): Promise<JobRecord[]> {
  const rows = await db().all<JobRow>(
    'SELECT * FROM jobs WHERE rendition_id = ? ORDER BY created_at DESC LIMIT ?',
    [renditionId, limit],
  );
  return rows.map(mapJob);
}

export async function listJobUnits(jobId: string): Promise<JobUnit[]> {
  const rows = await db().all<UnitRow>(
    'SELECT * FROM job_units WHERE job_id = ? ORDER BY stage, ordinal',
    [jobId],
  );
  return rows.map(mapUnit);
}

/** The job's original payload (mode etc.) without widening JobRecord. */
export async function getJobPayload(id: string): Promise<unknown> {
  const row = await db().first<{ payload_json: string | null }>(
    'SELECT payload_json FROM jobs WHERE id = ?',
    [id],
  );
  if (!row?.payload_json) return null;
  try {
    return JSON.parse(row.payload_json) as unknown;
  } catch {
    return null;
  }
}

/**
 * Copy completed units from a previous job into a fresh job. Used so a retry
 * after a failure/cancel reuses finished work instead of redoing it.
 */
export async function adoptDoneUnits(input: {
  fromJobId: string;
  toJobId: string;
  stages: GenerationStage[];
  now: number;
}): Promise<number> {
  if (!input.stages.length) return 0;
  const placeholders = input.stages.map(() => '?').join(',');
  const rows = await db().all<UnitRow>(
    `SELECT * FROM job_units
      WHERE job_id = ? AND stage IN (${placeholders}) AND status = 'done'
      ORDER BY stage, ordinal`,
    [input.fromJobId, ...input.stages],
  );
  if (!rows.length) return 0;
  await db().transaction(async () => {
    for (const row of rows) {
      await db().run(
        `INSERT OR IGNORE INTO job_units
           (id, job_id, stage, ordinal, status, input_key, payload_json, result_json,
            attempts, started_at, finished_at, duration_ms, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          newId('ju'),
          input.toJobId,
          row.stage,
          row.ordinal,
          row.input_key,
          row.payload_json,
          row.result_json,
          row.attempts,
          row.started_at,
          row.finished_at,
          row.duration_ms,
          input.now,
          input.now,
        ],
      );
    }
  });
  return rows.length;
}

/** Queued -> running, attempts+1. Single writer; false means another runner won. */
export async function claimJob(id: string, now: number): Promise<boolean> {
  const result = await db().run(
    `UPDATE jobs
        SET status = 'running', started_at = COALESCE(started_at, ?), heartbeat_at = ?,
            attempts = attempts + 1, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'`,
    [now, now, now, id],
  );
  return result.changes > 0;
}

export async function heartbeat(
  id: string,
  patch: {
    stage?: GenerationStage;
    unitsDone?: number;
    unitsTotal?: number;
    etaRemainingMs?: number | null;
    etaLowMs?: number | null;
    etaHighMs?: number | null;
    progress?: number;
  },
  now: number,
): Promise<void> {
  const fields: string[] = ['heartbeat_at = ?', 'updated_at = ?'];
  const params: unknown[] = [now, now];
  if (patch.stage !== undefined) {
    fields.push('stage = ?');
    params.push(patch.stage);
  }
  if (patch.unitsDone !== undefined) {
    fields.push('units_done = ?');
    params.push(Math.max(0, Math.round(patch.unitsDone)));
  }
  if (patch.unitsTotal !== undefined) {
    fields.push('units_total = ?');
    params.push(Math.max(0, Math.round(patch.unitsTotal)));
  }
  if (patch.etaRemainingMs !== undefined) {
    fields.push('eta_remaining_ms = ?');
    params.push(patch.etaRemainingMs);
  }
  if (patch.etaLowMs !== undefined) {
    fields.push('eta_low_ms = ?');
    params.push(patch.etaLowMs);
  }
  if (patch.etaHighMs !== undefined) {
    fields.push('eta_high_ms = ?');
    params.push(patch.etaHighMs);
  }
  if (patch.progress !== undefined) {
    fields.push('progress = ?');
    params.push(Math.max(0, Math.min(1, patch.progress)));
  }
  params.push(id);
  await db().run(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function finishJob(
  id: string,
  status: 'done' | 'failed',
  input: { error?: string | null; now: number },
): Promise<void> {
  await db().run(
    `UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [status, input.error ?? null, input.now, input.now, id],
  );
}

export async function requestCancel(id: string, now: number): Promise<void> {
  await db().run('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?', [
    now,
    id,
  ]);
}

export async function cancelJob(
  id: string,
  input: { error?: string; now: number },
): Promise<void> {
  await db().run(
    `UPDATE jobs
        SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
    [input.now, input.error ?? 'cancelled', input.now, id],
  );
}

/**
 * Requeue orphaned running jobs. `mode:'boot'` trusts that no runner exists in
 * a fresh process, so heartbeat age is irrelevant; `mode:'lease'` only touches
 * jobs whose heartbeat is older than the lease.
 */
export async function recoverStaleJobs(input: {
  now: number;
  mode: 'boot' | 'lease';
}): Promise<{ recovered: number; cancelled: number }> {
  return db().transaction(async () => {
    const cutoff = input.now - JOB_LEASE_MS;
    const boot = input.mode === 'boot' ? 1 : 0;

    // Cancel first: its running units must stay untouched for post-mortem.
    // cancel_requested wins regardless of heartbeat age (a live runner observes
    // the flag at its next unit boundary); terminal writes are status-guarded.
    const cancelled = await db().run(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE status = 'running' AND cancel_requested = 1`,
      [input.now, input.now],
    );

    await db().run(
      `UPDATE job_units
          SET status = 'pending', error = COALESCE(error, 'interrupted'), updated_at = ?
        WHERE status = 'running'
          AND job_id IN (SELECT id FROM jobs WHERE status = 'running'
                         AND (? = 1 OR heartbeat_at IS NULL OR heartbeat_at < ?))`,
      [input.now, boot, cutoff],
    );

    const recovered = await db().run(
      `UPDATE jobs SET status = 'queued', heartbeat_at = NULL, updated_at = ?
        WHERE status = 'running'
          AND (? = 1 OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
      [input.now, boot, cutoff],
    );

    return { recovered: recovered.changes, cancelled: cancelled.changes };
  });
}

/** A done checkpoint with the current key is never clobbered. */
export async function beginUnit(input: {
  jobId: string;
  stage: GenerationStage;
  ordinal: number;
  inputKey: string;
  payloadJson: string;
  now: number;
}): Promise<boolean> {
  const result = await db().run(
    `INSERT INTO job_units
       (id, job_id, stage, ordinal, status, input_key, payload_json, result_json,
        attempts, started_at, finished_at, duration_ms, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, 1, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (job_id, stage, ordinal) DO UPDATE SET
       status       = 'running',
       input_key    = excluded.input_key,
       payload_json = excluded.payload_json,
       result_json  = NULL,
       attempts     = job_units.attempts + 1,
       started_at   = excluded.started_at,
       finished_at  = NULL,
       duration_ms  = NULL,
       error        = NULL,
       updated_at   = excluded.updated_at
     WHERE job_units.status <> 'done'`,
    [
      newId('ju'),
      input.jobId,
      input.stage,
      input.ordinal,
      input.inputKey,
      input.payloadJson,
      input.now,
      input.now,
      input.now,
    ],
  );
  return result.changes > 0;
}

/** A late result from a superseded plan is discarded (input_key guard). */
export async function finishUnit(input: {
  jobId: string;
  stage: GenerationStage;
  ordinal: number;
  inputKey: string;
  resultJson: string;
  durationMs: number;
  now: number;
}): Promise<void> {
  await db().run(
    `UPDATE job_units
        SET status = 'done', result_json = ?, duration_ms = ?, finished_at = ?, error = NULL, updated_at = ?
      WHERE job_id = ? AND stage = ? AND ordinal = ? AND input_key = ?`,
    [
      input.resultJson,
      Math.max(0, Math.round(input.durationMs)),
      input.now,
      input.now,
      input.jobId,
      input.stage,
      input.ordinal,
      input.inputKey,
    ],
  );
}

export async function failUnit(input: {
  jobId: string;
  stage: GenerationStage;
  ordinal: number;
  inputKey: string;
  error: string;
  durationMs: number;
  now: number;
}): Promise<void> {
  await db().run(
    `UPDATE job_units
        SET status = 'failed', error = ?, duration_ms = ?, finished_at = ?, updated_at = ?
      WHERE job_id = ? AND stage = ? AND ordinal = ? AND input_key = ? AND status <> 'done'`,
    [
      input.error,
      Math.max(0, Math.round(input.durationMs)),
      input.now,
      input.now,
      input.jobId,
      input.stage,
      input.ordinal,
      input.inputKey,
    ],
  );
}

/** Drop checkpoints for invalidated stages without touching the job row. */
export async function deleteJobUnits(
  jobId: string,
  stages?: GenerationStage[],
): Promise<void> {
  if (stages && !stages.length) return;
  if (!stages) {
    await db().run('DELETE FROM job_units WHERE job_id = ?', [jobId]);
    return;
  }
  const placeholders = stages.map(() => '?').join(',');
  await db().run(`DELETE FROM job_units WHERE job_id = ? AND stage IN (${placeholders})`, [
    jobId,
    ...stages,
  ]);
}
