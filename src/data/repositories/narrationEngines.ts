import { db } from '@/data/db';
import type { RenditionEngine } from '@/domain/narration';

export type NarrationEngineStatus = 'absent' | 'downloading' | 'ready' | 'failed';

export type NarrationEngineRecord = {
  id: string;
  engine: Extract<RenditionEngine, 'piper' | 'kokoro'>;
  label: string;
  bundleUrl: string | null;
  bundleBytes: number | null;
  modelDir: string | null;
  status: NarrationEngineStatus;
  progress: number;
  verifiedAt: number | null;
  error: string | null;
  updatedAt: number;
};

type NarrationEngineRow = {
  id: string;
  engine: string;
  label: string;
  bundle_url: string | null;
  bundle_bytes: number | null;
  model_dir: string | null;
  status: string;
  progress: number;
  verified_at: number | null;
  error: string | null;
  updated_at: number;
};

function mapRow(row: NarrationEngineRow): NarrationEngineRecord {
  return {
    id: row.id,
    engine: row.engine === 'kokoro' ? 'kokoro' : 'piper',
    label: row.label,
    bundleUrl: row.bundle_url,
    bundleBytes: row.bundle_bytes,
    modelDir: row.model_dir,
    status: row.status as NarrationEngineStatus,
    progress: row.progress,
    verifiedAt: row.verified_at,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

export async function listNarrationEngines(): Promise<NarrationEngineRecord[]> {
  const rows = await db().all<NarrationEngineRow>(
    'SELECT * FROM narration_engines ORDER BY updated_at DESC',
  );
  return rows.map(mapRow);
}

export async function getNarrationEngine(id: string): Promise<NarrationEngineRecord | null> {
  const row = await db().first<NarrationEngineRow>(
    'SELECT * FROM narration_engines WHERE id = ?',
    [id],
  );
  return row ? mapRow(row) : null;
}

export async function upsertNarrationEngine(input: {
  id: string;
  engine: 'piper' | 'kokoro';
  label: string;
  bundleUrl?: string | null;
  bundleBytes?: number | null;
  modelDir?: string | null;
  status?: NarrationEngineStatus;
  progress?: number;
  verifiedAt?: number | null;
  error?: string | null;
}): Promise<NarrationEngineRecord> {
  const now = Date.now();
  await db().run(
    `INSERT INTO narration_engines
       (id, engine, label, bundle_url, bundle_bytes, model_dir, status, progress, verified_at, error, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       engine=excluded.engine,
       label=excluded.label,
       bundle_url=excluded.bundle_url,
       bundle_bytes=excluded.bundle_bytes,
       model_dir=excluded.model_dir,
       status=excluded.status,
       progress=excluded.progress,
       verified_at=excluded.verified_at,
       error=excluded.error,
       updated_at=excluded.updated_at`,
    [
      input.id,
      input.engine,
      input.label,
      input.bundleUrl ?? null,
      input.bundleBytes ?? null,
      input.modelDir ?? null,
      input.status ?? 'absent',
      input.progress ?? 0,
      input.verifiedAt ?? null,
      input.error ?? null,
      now,
    ],
  );
  const row = await getNarrationEngine(input.id);
  if (!row) throw new Error('Narration engine row was not written.');
  return row;
}

export async function updateNarrationEngine(
  id: string,
  patch: Partial<
    Pick<
      NarrationEngineRecord,
      | 'label'
      | 'bundleUrl'
      | 'bundleBytes'
      | 'modelDir'
      | 'status'
      | 'progress'
      | 'verifiedAt'
      | 'error'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.label !== undefined) set('label', patch.label);
  if (patch.bundleUrl !== undefined) set('bundle_url', patch.bundleUrl);
  if (patch.bundleBytes !== undefined) set('bundle_bytes', patch.bundleBytes);
  if (patch.modelDir !== undefined) set('model_dir', patch.modelDir);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.progress !== undefined) set('progress', patch.progress);
  if (patch.verifiedAt !== undefined) set('verified_at', patch.verifiedAt);
  if (patch.error !== undefined) set('error', patch.error);
  if (!fields.length) return;

  fields.push('updated_at = ?');
  params.push(Date.now(), id);
  await db().run(`UPDATE narration_engines SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function setNarrationEngineStatus(
  id: string,
  status: NarrationEngineStatus,
  error?: string | null,
): Promise<void> {
  await db().run(
    'UPDATE narration_engines SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    [status, error ?? null, Date.now(), id],
  );
}

export async function setNarrationEngineProgress(id: string, progress: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, progress));
  await db().run(
    'UPDATE narration_engines SET progress = ?, updated_at = ? WHERE id = ?',
    [clamped, Date.now(), id],
  );
}

export async function deleteNarrationEngine(id: string): Promise<void> {
  await db().run('DELETE FROM narration_engines WHERE id = ?', [id]);
}
