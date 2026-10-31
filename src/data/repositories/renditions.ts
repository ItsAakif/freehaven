import { db } from '@/data/db';
import { newId } from '@/lib/id';
import type { Book } from '@/domain/types';
import type {
  LibraryEntry,
  LibraryShelf,
  NarrationLength,
  QueuedSegment,
  Rendition,
  RenditionEngine,
  RenditionProgress,
  RenditionSegment,
  RenditionStatus,
  SegmentStatus,
} from '@/domain/narration';
import { listBooksByIds } from './books';

/* ------------------------------------------------------------------ types */

type RenditionRow = {
  id: string;
  book_id: string;
  language: string;
  style_id: string;
  length_preset: string;
  engine: string;
  voice: string | null;
  model: string | null;
  instruction: string | null;
  instruction_hash: string | null;
  status: string;
  script_md: string | null;
  script_provider: string | null;
  script_model: string | null;
  word_count: number;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type SegmentRow = {
  id: string;
  rendition_id: string;
  ordinal: number;
  section_id: string | null;
  section_ordinal: number | null;
  title: string | null;
  text: string;
  speech_key: string | null;
  file_path: string | null;
  format: string | null;
  duration_ms: number | null;
  bytes: number | null;
  start_ms: number;
  timings_json: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type ProgressRow = {
  rendition_id: string;
  position_ms: number;
  percent: number;
  completed: number;
  updated_at: number;
};

type ShelfRow = {
  book_id: string;
  rendition_id: string | null;
  audio_percent?: number | null;
  position_ms?: number | null;
  percent?: number | null;
  completed?: number | null;
  read_percent?: number | null;
  updated_at: number;
};

function mapRendition(row: RenditionRow): Rendition {
  return {
    id: row.id,
    bookId: row.book_id,
    language: row.language,
    styleId: row.style_id,
    length: row.length_preset as NarrationLength,
    engine: row.engine as RenditionEngine,
    voice: row.voice,
    model: row.model,
    instruction: row.instruction,
    instructionHash: row.instruction_hash,
    status: row.status as RenditionStatus,
    scriptMd: row.script_md,
    scriptProvider: row.script_provider,
    scriptModel: row.script_model,
    wordCount: row.word_count,
    durationMs: row.duration_ms,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSegment(row: SegmentRow): RenditionSegment {
  return {
    id: row.id,
    renditionId: row.rendition_id,
    ordinal: row.ordinal,
    sectionId: row.section_id,
    sectionOrdinal: row.section_ordinal,
    title: row.title,
    text: row.text,
    speechKey: row.speech_key,
    filePath: row.file_path,
    format: row.format as 'mp3' | 'wav' | null,
    durationMs: row.duration_ms,
    bytes: row.bytes,
    startMs: row.start_ms,
    timingsJson: row.timings_json ?? null,
    status: row.status as SegmentStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProgress(row: ProgressRow): RenditionProgress {
  return {
    renditionId: row.rendition_id,
    positionMs: row.position_ms,
    percent: row.percent,
    completed: row.completed === 1,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------ pure helper */

/** Pure identity for a rendition tuple. Used by tests and logs, never stored. */
export function renditionKey(input: {
  bookId: string;
  language: string;
  styleId: string;
  length: NarrationLength;
}): string {
  return `${input.bookId}|${input.language}|${input.styleId}|${input.length}`;
}

/* ------------------------------------------------------------ renditions */

export async function getOrCreateRendition(input: {
  bookId: string;
  language: string;
  styleId: string;
  length: NarrationLength;
}): Promise<Rendition> {
  const now = Date.now();
  await db().run(
    `INSERT INTO renditions (id, book_id, language, style_id, length_preset, engine, status, word_count, created_at, updated_at)
     VALUES (?,?,?,?,?, 'device', 'draft', 0, ?, ?)
     ON CONFLICT(book_id, language, style_id, length_preset) DO NOTHING`,
    [newId('rd'), input.bookId, input.language, input.styleId, input.length, now, now],
  );
  const row = await db().first<RenditionRow>(
    `SELECT * FROM renditions WHERE book_id = ? AND language = ? AND style_id = ? AND length_preset = ?`,
    [input.bookId, input.language, input.styleId, input.length],
  );
  if (!row) throw new Error('Rendition create failed.');
  return mapRendition(row);
}

export async function getRendition(id: string): Promise<Rendition | null> {
  const row = await db().first<RenditionRow>('SELECT * FROM renditions WHERE id = ?', [id]);
  return row ? mapRendition(row) : null;
}

export async function listRenditions(bookId: string): Promise<Rendition[]> {
  const rows = await db().all<RenditionRow>(
    'SELECT * FROM renditions WHERE book_id = ? ORDER BY updated_at DESC',
    [bookId],
  );
  return rows.map(mapRendition);
}

/** Hydration helper: preserves input order and drops ids that no longer exist. */
export async function listRenditionsByIds(ids: string[]): Promise<Rendition[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db().all<RenditionRow>(
    `SELECT * FROM renditions WHERE id IN (${placeholders})`,
    ids,
  );
  const byId = new Map(rows.map((row) => [row.id, mapRendition(row)]));
  return ids.map((id) => byId.get(id)).filter((r): r is Rendition => !!r);
}

export async function updateRenditionScript(
  id: string,
  input: {
    scriptMd: string;
    provider: string;
    model?: string | null;
    wordCount: number;
    status?: RenditionStatus;
  },
): Promise<void> {
  await db().run(
    `UPDATE renditions
     SET script_md = ?, script_provider = ?, script_model = ?, word_count = ?,
         status = COALESCE(?, status), updated_at = ?
     WHERE id = ?`,
    [
      input.scriptMd,
      input.provider,
      input.model ?? null,
      input.wordCount,
      input.status ?? null,
      Date.now(),
      id,
    ],
  );
}

export async function setRenditionEngine(
  id: string,
  input: {
    engine: RenditionEngine;
    voice: string | null;
    model: string | null;
    instruction: string | null;
    instructionHash: string | null;
    status?: RenditionStatus;
  },
): Promise<void> {
  await db().run(
    `UPDATE renditions
     SET engine = ?, voice = ?, model = ?, instruction = ?, instruction_hash = ?,
         status = COALESCE(?, status), updated_at = ?
     WHERE id = ?`,
    [
      input.engine,
      input.voice,
      input.model,
      input.instruction,
      input.instructionHash,
      input.status ?? null,
      Date.now(),
      id,
    ],
  );
}

export async function setRenditionStatus(
  id: string,
  status: RenditionStatus,
  error?: string | null,
): Promise<void> {
  await db().run('UPDATE renditions SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
    status,
    error ?? null,
    Date.now(),
    id,
  ]);
}

/** Set the measured logical-asset duration after segment offsets are written. */
export async function setRenditionDuration(id: string, durationMs: number): Promise<void> {
  await db().run('UPDATE renditions SET duration_ms = ?, updated_at = ? WHERE id = ?', [
    Math.max(0, Math.round(durationMs)),
    Date.now(),
    id,
  ]);
}

/* -------------------------------------------------------------- segments */

export async function listSegments(renditionId: string): Promise<RenditionSegment[]> {
  const rows = await db().all<SegmentRow>(
    'SELECT * FROM rendition_segments WHERE rendition_id = ? ORDER BY ordinal',
    [renditionId],
  );
  return rows.map(mapSegment);
}

/**
 * Transactional segment reconcile. Segments whose (ordinal, speechKey, text) are unchanged keep
 * their file_path/duration/status. Changed or new rows are inserted as 'queued'. Removed ordinals
 * are deleted; their files are cleaned up by the caller.
 */
export async function replaceSegments(
  renditionId: string,
  segments: QueuedSegment[],
): Promise<RenditionSegment[]> {
  const now = Date.now();
  await db().transaction(async () => {
    const existing = await db().all<SegmentRow>(
      'SELECT * FROM rendition_segments WHERE rendition_id = ? ORDER BY ordinal',
      [renditionId],
    );
    const byOrdinal = new Map(existing.map((row) => [row.ordinal, row]));
    const keep = new Set<number>();

    for (let ordinal = 0; ordinal < segments.length; ordinal += 1) {
      const segment = segments[ordinal];
      keep.add(ordinal);
      const current = byOrdinal.get(ordinal);
      const unchanged =
        current && current.speech_key === segment.speechKey && current.text === segment.text;

      if (unchanged && current) {
        await db().run(
          `UPDATE rendition_segments
           SET section_id = ?, section_ordinal = ?, title = ?,
               timings_json = COALESCE(?, timings_json), updated_at = ?
           WHERE id = ?`,
          [
            segment.sectionId,
            segment.sectionOrdinal,
            segment.title,
            segment.timingsJson ?? null,
            now,
            current.id,
          ],
        );
        continue;
      }

      if (current) {
        await db().run(
          `UPDATE rendition_segments
           SET section_id = ?, section_ordinal = ?, title = ?, text = ?, speech_key = ?,
               file_path = NULL, format = NULL, duration_ms = NULL, bytes = NULL,
               start_ms = 0, timings_json = ?, status = 'queued', error = NULL, updated_at = ?
           WHERE id = ?`,
          [
            segment.sectionId,
            segment.sectionOrdinal,
            segment.title,
            segment.text,
            segment.speechKey,
            segment.timingsJson ?? null,
            now,
            current.id,
          ],
        );
      } else {
        await db().run(
          `INSERT INTO rendition_segments
             (id, rendition_id, ordinal, section_id, section_ordinal, title, text, speech_key,
              file_path, format, duration_ms, bytes, start_ms, timings_json, status, error,
              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?, NULL, NULL, NULL, NULL, 0, ?, 'queued', NULL, ?, ?)`,
          [
            newId('rs'),
            renditionId,
            ordinal,
            segment.sectionId,
            segment.sectionOrdinal,
            segment.title,
            segment.text,
            segment.speechKey,
            segment.timingsJson ?? null,
            now,
            now,
          ],
        );
      }
    }

    for (const row of existing) {
      if (!keep.has(row.ordinal)) {
        await db().run('DELETE FROM rendition_segments WHERE id = ?', [row.id]);
      }
    }
  });

  return listSegments(renditionId);
}

export async function updateSegment(
  id: string,
  patch: Partial<
    Pick<
      RenditionSegment,
      'speechKey' | 'filePath' | 'format' | 'durationMs' | 'bytes' | 'timingsJson' | 'status' | 'error'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.speechKey !== undefined) {
    fields.push('speech_key = ?');
    params.push(patch.speechKey);
  }
  if (patch.filePath !== undefined) {
    fields.push('file_path = ?');
    params.push(patch.filePath);
  }
  if (patch.format !== undefined) {
    fields.push('format = ?');
    params.push(patch.format);
  }
  if (patch.durationMs !== undefined) {
    fields.push('duration_ms = ?');
    params.push(patch.durationMs);
  }
  if (patch.bytes !== undefined) {
    fields.push('bytes = ?');
    params.push(patch.bytes);
  }
  if (patch.timingsJson !== undefined) {
    fields.push('timings_json = ?');
    params.push(patch.timingsJson);
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    params.push(patch.status);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    params.push(patch.error);
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  params.push(Date.now(), id);
  await db().run(`UPDATE rendition_segments SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function updateSegmentOffsets(
  renditionId: string,
  offsets: { id: string; startMs: number }[],
): Promise<void> {
  if (!offsets.length) return;
  const now = Date.now();
  await db().transaction(async () => {
    for (const offset of offsets) {
      await db().run(
        'UPDATE rendition_segments SET start_ms = ?, updated_at = ? WHERE id = ? AND rendition_id = ?',
        [offset.startMs, now, offset.id, renditionId],
      );
    }
  });
}

export async function renditionStats(renditionId: string): Promise<{
  segments: number;
  ready: number;
  failed: number;
  bytes: number;
  durationMs: number;
}> {
  const row = await db().first<{
    segments: number;
    ready: number;
    failed: number;
    bytes: number;
    duration_ms: number;
  }>(
    `SELECT COUNT(*) AS segments,
            COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(bytes), 0) AS bytes,
            COALESCE(SUM(duration_ms), 0) AS duration_ms
     FROM rendition_segments WHERE rendition_id = ?`,
    [renditionId],
  );
  return {
    segments: row?.segments ?? 0,
    ready: row?.ready ?? 0,
    failed: row?.failed ?? 0,
    bytes: row?.bytes ?? 0,
    durationMs: row?.duration_ms ?? 0,
  };
}

export async function isRenditionDownloaded(renditionId: string): Promise<boolean> {
  const row = await db().first<{ total: number; ready: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'ready' AND file_path IS NOT NULL THEN 1 ELSE 0 END), 0) AS ready
     FROM rendition_segments WHERE rendition_id = ?`,
    [renditionId],
  );
  return !!row && row.total > 0 && row.ready === row.total;
}

/* -------------------------------------------------------------- progress */

export async function getRenditionProgress(
  renditionId: string,
): Promise<RenditionProgress | null> {
  const row = await db().first<ProgressRow>(
    'SELECT * FROM rendition_progress WHERE rendition_id = ?',
    [renditionId],
  );
  return row ? mapProgress(row) : null;
}

export async function saveRenditionProgress(input: {
  renditionId: string;
  positionMs: number;
  percent: number;
  completed: boolean;
}): Promise<void> {
  const positionMs = Math.max(0, Math.round(input.positionMs));
  const percent = Math.max(0, Math.min(1, input.percent));
  await db().run(
    `INSERT INTO rendition_progress (rendition_id, position_ms, percent, completed, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(rendition_id) DO UPDATE SET position_ms=excluded.position_ms,
       percent=excluded.percent, completed=excluded.completed, updated_at=excluded.updated_at`,
    [input.renditionId, positionMs, percent, input.completed ? 1 : 0, Date.now()],
  );
}

export async function deleteRendition(id: string): Promise<void> {
  await db().run('DELETE FROM renditions WHERE id = ?', [id]);
}

/* --------------------------------------------------------------- library */

/**
 * Library shelves. Each shelf is a single id+progress statement; hydration then uses
 * listBooksByIds + listRenditionsByIds so no column collisions and no per-row query.
 */
export async function listLibraryEntries(
  shelf: LibraryShelf,
  limit = 100,
): Promise<LibraryEntry[]> {
  const rows = await db().all<ShelfRow>(shelfSql(shelf), [limit]);
  if (!rows.length) return [];

  const bookIds = rows.map((row) => row.book_id);
  const renditionIds = rows
    .map((row) => row.rendition_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const [books, renditions] = await Promise.all([
    listBooksByIds(bookIds),
    listRenditionsByIds(renditionIds),
  ]);
  const bookById = new Map(books.map((book) => [book.id, book]));
  const renditionById = new Map(renditions.map((rendition) => [rendition.id, rendition]));

  const entries: LibraryEntry[] = [];
  for (const row of rows) {
    const book: Book | undefined = bookById.get(row.book_id);
    if (!book) continue;
    const rendition =
      row.rendition_id && renditionById.get(row.rendition_id)
        ? (renditionById.get(row.rendition_id) as Rendition)
        : null;

    if (shelf === 'in_progress') {
      const audioPercent = row.audio_percent ?? null;
      const isAudio = audioPercent !== null && audioPercent > 0.005;
      entries.push({
        book,
        rendition: isAudio ? rendition : null,
        positionMs: isAudio ? row.position_ms ?? 0 : 0,
        percent: isAudio ? audioPercent : row.read_percent ?? 0,
        completed: isAudio ? row.completed === 1 : false,
        downloaded: false,
        updatedAt: row.updated_at ?? 0,
      });
      continue;
    }

    entries.push({
      book,
      rendition,
      positionMs: row.position_ms ?? 0,
      percent: row.percent ?? 0,
      completed: row.completed === 1,
      downloaded: shelf === 'downloaded' && !!rendition,
      updatedAt: row.updated_at ?? 0,
    });
  }
  return entries;
}

function shelfSql(shelf: LibraryShelf): string {
  if (shelf === 'completed') {
    return `SELECT r.book_id,
                   r.id AS rendition_id,
                   p.position_ms,
                   p.percent,
                   p.completed,
                   p.updated_at
            FROM renditions r
            JOIN books b ON b.id = r.book_id
            JOIN rendition_progress p ON p.rendition_id = r.id
            WHERE b.in_library = 1 AND p.completed = 1
            ORDER BY p.updated_at DESC
            LIMIT ?`;
  }
  if (shelf === 'downloaded') {
    return `SELECT r.book_id,
                   r.id AS rendition_id,
                   COALESCE(p.position_ms, 0) AS position_ms,
                   COALESCE(p.percent, 0)     AS percent,
                   COALESCE(p.completed, 0)   AS completed,
                   COALESCE(p.updated_at, r.updated_at) AS updated_at
            FROM renditions r
            JOIN books b ON b.id = r.book_id
            LEFT JOIN rendition_progress p ON p.rendition_id = r.id
            WHERE b.in_library = 1
              AND EXISTS (SELECT 1 FROM rendition_segments s WHERE s.rendition_id = r.id)
              AND NOT EXISTS (
                    SELECT 1 FROM rendition_segments s
                    WHERE s.rendition_id = r.id
                      AND (s.status <> 'ready' OR s.file_path IS NULL)
                  )
            ORDER BY updated_at DESC
            LIMIT ?`;
  }
  return `SELECT b.id AS book_id,
                 r.id AS rendition_id,
                 p.percent    AS audio_percent,
                 p.position_ms,
                 p.completed,
                 rp.percent   AS read_percent,
                 COALESCE(p.updated_at, rp.updated_at, b.updated_at) AS updated_at
          FROM books b
          LEFT JOIN reading_positions rp ON rp.book_id = b.id
          LEFT JOIN renditions r
                 ON r.book_id = b.id
                AND r.id = (
                  SELECT r2.id FROM renditions r2
                  WHERE r2.book_id = b.id
                  ORDER BY r2.updated_at DESC LIMIT 1
                )
          LEFT JOIN rendition_progress p ON p.rendition_id = r.id
          WHERE b.in_library = 1
            AND (
                  (p.percent > 0.005 AND p.completed = 0)
               OR (p.percent IS NULL AND rp.percent > 0.005 AND rp.percent < 1)
            )
          ORDER BY COALESCE(p.updated_at, rp.updated_at, b.updated_at) DESC
          LIMIT ?`;
}
