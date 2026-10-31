/**
 * Full Guide repositories.
 *
 * Thin SQL wrappers: no AI, no audio and no filesystem access. Guide audio is
 * described by `guide_chapter_segments`; `guide_chapters.audio_path` is only
 * populated for the one-segment case.
 */

import { db } from '@/data/db';
import { newId, startOfDay } from '@/lib/id';
import type { QueuedSegment } from '@/domain/narration';
import type {
  Guide,
  GuideChapter,
  GuideChapterSegment,
  GuideChapterStatus,
  GuideStatus,
  NewGuideChapter,
} from '@/domain/guides';
import { guideStatusFor, streakFromDayKeys } from '@/domain/guides';

type GuideRow = {
  id: string;
  book_id: string;
  plan_id: string | null;
  title: string;
  style_id: string;
  language: string;
  engine: string;
  voice: string | null;
  model: string | null;
  words_per_chapter: number;
  chapters_per_day: number;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type GuideChapterRow = {
  id: string;
  guide_id: string;
  ordinal: number;
  title: string;
  start_page: number | null;
  end_page: number | null;
  section_ids_json: string;
  summary_md: string | null;
  word_count: number;
  provider: string | null;
  model: string | null;
  status: string;
  error: string | null;
  audio_path: string | null;
  duration_ms: number | null;
  timings_json: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type GuideChapterSegmentRow = {
  id: string;
  guide_chapter_id: string;
  ordinal: number;
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

function parseSectionIds(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

function mapGuide(row: GuideRow): Guide {
  return {
    id: row.id,
    bookId: row.book_id,
    planId: row.plan_id,
    title: row.title,
    styleId: row.style_id as Guide['styleId'],
    language: row.language,
    engine: row.engine as Guide['engine'],
    voice: row.voice,
    model: row.model,
    wordsPerChapter: row.words_per_chapter,
    chaptersPerDay: row.chapters_per_day,
    status: row.status as GuideStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChapter(row: GuideChapterRow): GuideChapter {
  return {
    id: row.id,
    guideId: row.guide_id,
    ordinal: row.ordinal,
    title: row.title,
    startPage: row.start_page,
    endPage: row.end_page,
    sectionIds: parseSectionIds(row.section_ids_json),
    summaryMd: row.summary_md,
    wordCount: row.word_count,
    provider: row.provider,
    model: row.model,
    status: row.status as GuideChapterStatus,
    error: row.error,
    audioPath: row.audio_path,
    durationMs: row.duration_ms,
    timingsJson: row.timings_json,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSegment(row: GuideChapterSegmentRow): GuideChapterSegment {
  return {
    id: row.id,
    guideChapterId: row.guide_chapter_id,
    ordinal: row.ordinal,
    text: row.text,
    speechKey: row.speech_key,
    filePath: row.file_path,
    format: row.format as 'mp3' | 'wav' | null,
    durationMs: row.duration_ms,
    bytes: row.bytes,
    startMs: row.start_ms,
    timingsJson: row.timings_json,
    status: row.status as GuideChapterSegment['status'],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ---------------------------------------------------------------- guides */

export async function getOrCreateGuide(input: {
  bookId: string;
  title: string;
  styleId: Guide['styleId'];
  language: string;
  engine: Guide['engine'];
  voice: string | null;
  model: string | null;
  wordsPerChapter?: number;
  chaptersPerDay?: number;
}): Promise<Guide> {
  const now = Date.now();
  await db().run(
    `INSERT INTO guides
       (id, book_id, title, style_id, language, engine, voice, model,
        words_per_chapter, chapters_per_day, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)
     ON CONFLICT(book_id, language, style_id) DO NOTHING`,
    [
      newId('gd'),
      input.bookId,
      input.title,
      input.styleId,
      input.language,
      input.engine,
      input.voice,
      input.model,
      input.wordsPerChapter ?? 250,
      input.chaptersPerDay ?? 1,
      now,
      now,
    ],
  );
  const row = await db().first<GuideRow>(
    'SELECT * FROM guides WHERE book_id = ? AND language = ? AND style_id = ?',
    [input.bookId, input.language, input.styleId],
  );
  if (!row) throw new Error('Guide create failed.');
  return mapGuide(row);
}

export async function getGuide(id: string): Promise<Guide | null> {
  const row = await db().first<GuideRow>('SELECT * FROM guides WHERE id = ?', [id]);
  return row ? mapGuide(row) : null;
}

export async function listGuides(bookId: string): Promise<Guide[]> {
  const rows = await db().all<GuideRow>(
    'SELECT * FROM guides WHERE book_id = ? ORDER BY updated_at DESC',
    [bookId],
  );
  return rows.map(mapGuide);
}

export async function setGuideEngine(
  id: string,
  input: {
    engine: Guide['engine'];
    voice: string | null;
    model: string | null;
  },
): Promise<void> {
  await db().run(
    'UPDATE guides SET engine = ?, voice = ?, model = ?, updated_at = ? WHERE id = ?',
    [input.engine, input.voice, input.model, Date.now(), id],
  );
}

export async function setGuideStatus(
  id: string,
  status: GuideStatus,
  error?: string | null,
): Promise<void> {
  await db().run('UPDATE guides SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
    status,
    error ?? null,
    Date.now(),
    id,
  ]);
}

/** Transactional plan reconcile: the plan contains exactly the guide's chapters. */
async function ensureGuidePlanTx(guideId: string): Promise<string> {
  const guide = await getGuide(guideId);
  if (!guide) throw new Error('Guide not found.');
  const book = await db().first<{ title: string | null }>('SELECT title FROM books WHERE id = ?', [
    guide.bookId,
  ]);
  const chapters = await db().all<{ id: string; ordinal: number }>(
    'SELECT id, ordinal FROM guide_chapters WHERE guide_id = ? ORDER BY ordinal',
    [guideId],
  );
  const now = Date.now();
  const count = chapters.length;
  const title = `${book?.title ?? guide.title} · Full guide`;
  const goal = `${count} ${count === 1 ? 'chapter' : 'chapters'}, one a day`;

  let planId = guide.planId;
  if (planId) {
    await db().run('UPDATE plans SET title = ?, goal = ? WHERE id = ?', [title, goal, planId]);
  } else {
    planId = newId('plan');
    await db().run('INSERT INTO plans (id, title, goal, created_at) VALUES (?,?,?,?)', [
      planId,
      title,
      goal,
      now,
    ]);
  }

  await db().run('DELETE FROM plan_items WHERE plan_id = ?', [planId]);
  for (const chapter of chapters) {
    await db().run(
      `INSERT INTO plan_items (id, plan_id, book_id, ordinal, status, guide_chapter_id)
       VALUES (?,?,?,?, 'todo', ?)`,
      [newId('pi'), planId, guide.bookId, chapter.ordinal, chapter.id],
    );
  }
  await db().run('UPDATE guides SET plan_id = ?, updated_at = ? WHERE id = ?', [
    planId,
    now,
    guideId,
  ]);
  return planId;
}

export async function ensureGuidePlan(guideId: string): Promise<string> {
  return db().transaction(async () => ensureGuidePlanTx(guideId));
}

/**
 * Transactional chapter replace. Deleting the old chapters cascades their
 * segments and plan items; a fresh dense plan is then written.
 */
export async function replaceGuideChapters(
  guideId: string,
  chapters: NewGuideChapter[],
): Promise<GuideChapter[]> {
  if (!chapters.length) throw new Error('Guide needs at least one chapter.');
  const now = Date.now();
  await db().transaction(async () => {
    await db().run('DELETE FROM guide_chapters WHERE guide_id = ?', [guideId]);
    for (let ordinal = 0; ordinal < chapters.length; ordinal += 1) {
      const chapter = chapters[ordinal];
      await db().run(
        `INSERT INTO guide_chapters
           (id, guide_id, ordinal, title, start_page, end_page, section_ids_json,
            word_count, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 0, 'pending', ?, ?)`,
        [
          newId('gc'),
          guideId,
          ordinal,
          chapter.title,
          chapter.startPage,
          chapter.endPage,
          JSON.stringify(chapter.sectionIds),
          now,
          now,
        ],
      );
    }
    await db().run("UPDATE guides SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?", [
      now,
      guideId,
    ]);
    await ensureGuidePlanTx(guideId);
  });
  return listGuideChapters(guideId);
}

export async function listGuideChapters(guideId: string): Promise<GuideChapter[]> {
  const rows = await db().all<GuideChapterRow>(
    'SELECT * FROM guide_chapters WHERE guide_id = ? ORDER BY ordinal',
    [guideId],
  );
  return rows.map(mapChapter);
}

export async function getGuideChapter(id: string): Promise<GuideChapter | null> {
  const row = await db().first<GuideChapterRow>('SELECT * FROM guide_chapters WHERE id = ?', [id]);
  return row ? mapChapter(row) : null;
}

export async function updateGuideChapterScript(
  id: string,
  input: {
    summaryMd: string;
    wordCount: number;
    provider: string;
    model: string | null;
    status?: GuideChapterStatus;
    error?: string | null;
  },
): Promise<void> {
  await db().run(
    `UPDATE guide_chapters
     SET summary_md = ?, word_count = ?, provider = ?, model = ?,
         status = COALESCE(?, status), error = ?, updated_at = ?
     WHERE id = ?`,
    [
      input.summaryMd,
      input.wordCount,
      input.provider,
      input.model,
      input.status ?? null,
      input.error ?? null,
      Date.now(),
      id,
    ],
  );
}

export async function setGuideChapterStatus(
  id: string,
  status: GuideChapterStatus,
  error?: string | null,
): Promise<void> {
  await db().run('UPDATE guide_chapters SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
    status,
    error ?? null,
    Date.now(),
    id,
  ]);
}

export async function setGuideChapterAudio(
  id: string,
  input: {
    audioPath: string | null;
    durationMs: number;
    timingsJson: string | null;
  },
): Promise<void> {
  await db().run(
    `UPDATE guide_chapters
     SET audio_path = ?, duration_ms = ?, timings_json = ?, updated_at = ?
     WHERE id = ?`,
    [input.audioPath, Math.max(0, Math.round(input.durationMs)), input.timingsJson, Date.now(), id],
  );
}

/* -------------------------------------------------------------- segments */

export async function listGuideChapterSegments(
  chapterId: string,
): Promise<GuideChapterSegment[]> {
  const rows = await db().all<GuideChapterSegmentRow>(
    'SELECT * FROM guide_chapter_segments WHERE guide_chapter_id = ? ORDER BY ordinal',
    [chapterId],
  );
  return rows.map(mapSegment);
}

/**
 * Transactional segment reconcile with the same semantics as rendition
 * segments: unchanged `(ordinal, speechKey, text)` keeps its produced file and
 * duration; changed rows are reset to queued; removed ordinals are deleted.
 */
export async function replaceGuideChapterSegments(
  chapterId: string,
  segments: QueuedSegment[],
): Promise<GuideChapterSegment[]> {
  const now = Date.now();
  await db().transaction(async () => {
    const existing = await db().all<GuideChapterSegmentRow>(
      'SELECT * FROM guide_chapter_segments WHERE guide_chapter_id = ? ORDER BY ordinal',
      [chapterId],
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
          `UPDATE guide_chapter_segments
           SET timings_json = COALESCE(?, timings_json), updated_at = ?
           WHERE id = ?`,
          [segment.timingsJson ?? null, now, current.id],
        );
        continue;
      }

      if (current) {
        await db().run(
          `UPDATE guide_chapter_segments
           SET text = ?, speech_key = ?, file_path = NULL, format = NULL,
               duration_ms = NULL, bytes = NULL, start_ms = 0, timings_json = ?,
               status = 'queued', error = NULL, updated_at = ?
           WHERE id = ?`,
          [segment.text, segment.speechKey, segment.timingsJson ?? null, now, current.id],
        );
      } else {
        await db().run(
          `INSERT INTO guide_chapter_segments
             (id, guide_chapter_id, ordinal, text, speech_key, file_path, format,
              duration_ms, bytes, start_ms, timings_json, status, error, created_at, updated_at)
           VALUES (?,?,?,?,?, NULL, NULL, NULL, NULL, 0, ?, 'queued', NULL, ?, ?)`,
          [newId('gs'), chapterId, ordinal, segment.text, segment.speechKey, segment.timingsJson ?? null, now, now],
        );
      }
    }

    for (const row of existing) {
      if (!keep.has(row.ordinal)) {
        await db().run('DELETE FROM guide_chapter_segments WHERE id = ?', [row.id]);
      }
    }
  });

  return listGuideChapterSegments(chapterId);
}

export async function updateGuideChapterSegment(
  id: string,
  patch: Partial<
    Pick<
      GuideChapterSegment,
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
  await db().run(`UPDATE guide_chapter_segments SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function updateGuideChapterSegmentOffsets(
  chapterId: string,
  offsets: { id: string; startMs: number }[],
): Promise<void> {
  if (!offsets.length) return;
  const now = Date.now();
  await db().transaction(async () => {
    for (const offset of offsets) {
      await db().run(
        `UPDATE guide_chapter_segments
         SET start_ms = ?, updated_at = ?
         WHERE id = ? AND guide_chapter_id = ?`,
        [offset.startMs, now, offset.id, chapterId],
      );
    }
  });
}

/* ------------------------------------------------------------ daily path */

let json1Available: boolean | null = null;

export type TodayGuide =
  | {
      kind: 'next';
      guide: Guide;
      bookTitle: string;
      chapter: GuideChapter;
      total: number;
      done: number;
      completedToday: number;
      streakDays: number;
    }
  | {
      kind: 'done_today';
      guide: Guide;
      bookTitle: string;
      next: GuideChapter | null;
      total: number;
      done: number;
      completedToday: number;
      streakDays: number;
    }
  | {
      kind: 'complete';
      guide: Guide;
      bookTitle: string;
      total: number;
      done: number;
      streakDays: number;
    };

async function guideStreakDays(guideId: string, now: number): Promise<number> {
  if (json1Available === null) {
    try {
      const probe = await db().first<{ value: number | null }>(
        `SELECT json_extract('{"a":1}', '$.a') AS value`,
      );
      json1Available = probe?.value === 1;
    } catch {
      json1Available = false;
    }
  }

  let rows: { day: string }[];
  if (json1Available) {
    rows = await db().all<{ day: string }>(
      `SELECT DISTINCT date(created_at / 1000, 'unixepoch', 'localtime') AS day
       FROM activity_events
       WHERE kind = 'guide'
         AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.guideId') = ?
       ORDER BY day DESC`,
      [guideId],
    );
  } else {
    const escaped = guideId.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    rows = await db().all<{ day: string }>(
      `SELECT DISTINCT date(created_at / 1000, 'unixepoch', 'localtime') AS day
       FROM activity_events
       WHERE kind = 'guide'
         AND metadata_json LIKE ? ESCAPE '\\'
       ORDER BY day DESC`,
      [`%"guideId":"${escaped}"%`],
    );
  }
  return streakFromDayKeys(
    rows.map((row) => row.day),
    now,
  );
}

export async function guideStats(
  guideId: string,
  now = Date.now(),
): Promise<{
  chapters: number;
  ready: number;
  completed: number;
  words: number;
  durationMs: number;
  streakDays: number;
}> {
  const row = await db().first<{
    chapters: number;
    ready: number;
    completed: number;
    words: number | null;
    duration_ms: number | null;
  }>(
    `SELECT COUNT(*) AS chapters,
            COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
            COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(word_count), 0) AS words,
            COALESCE(SUM(duration_ms), 0) AS duration_ms
     FROM guide_chapters WHERE guide_id = ?`,
    [guideId],
  );
  return {
    chapters: row?.chapters ?? 0,
    ready: row?.ready ?? 0,
    completed: row?.completed ?? 0,
    words: row?.words ?? 0,
    durationMs: row?.duration_ms ?? 0,
    streakDays: await guideStreakDays(guideId, now),
  };
}

/** Latest guide (by updated_at) and its next actionable chapter. */
export async function guideForToday(now = Date.now()): Promise<TodayGuide | null> {
  const row = await db().first<GuideRow & { book_title: string | null }>(
    `SELECT g.*, b.title AS book_title
     FROM guides g JOIN books b ON b.id = g.book_id
     WHERE g.status IN ('ready', 'partial', 'generated')
     ORDER BY g.updated_at DESC LIMIT 1`,
  );
  if (!row) return null;

  const guide = mapGuide(row);
  const bookTitle = row.book_title ?? guide.title;
  const chapters = await listGuideChapters(guide.id);
  const total = chapters.length;
  const done = chapters.filter((chapter) => chapter.completedAt !== null).length;
  const completedTodayRow = await db().first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM guide_chapters WHERE guide_id = ? AND completed_at >= ?',
    [guide.id, startOfDay(now)],
  );
  const completedToday = completedTodayRow?.count ?? 0;
  const { streakDays } = await guideStats(guide.id, now);
  const nextIncomplete = chapters.find((chapter) => chapter.completedAt === null) ?? null;
  const allDone = total > 0 && done === total;

  if (completedToday >= guide.chaptersPerDay) {
    if (allDone) {
      return { kind: 'complete', guide, bookTitle, total, done, streakDays };
    }
    const next =
      nextIncomplete && nextIncomplete.status === 'ready' ? nextIncomplete : null;
    return {
      kind: 'done_today',
      guide,
      bookTitle,
      next,
      total,
      done,
      completedToday,
      streakDays,
    };
  }

  if (nextIncomplete && nextIncomplete.status === 'ready') {
    return {
      kind: 'next',
      guide,
      bookTitle,
      chapter: nextIncomplete,
      total,
      done,
      completedToday,
      streakDays,
    };
  }

  if (allDone) {
    return { kind: 'complete', guide, bookTitle, total, done, streakDays };
  }
  return null;
}

/** Idempotent listening completion. Logs one guide activity row the first time. */
export async function completeGuideChapter(chapterId: string, now = Date.now()): Promise<void> {
  await db().transaction(async () => {
    const chapter = await db().first<GuideChapterRow>(
      'SELECT * FROM guide_chapters WHERE id = ?',
      [chapterId],
    );
    if (!chapter) throw new Error('Guide chapter not found.');
    if (chapter.completed_at !== null) return;

    const guide = await db().first<GuideRow>('SELECT * FROM guides WHERE id = ?', [
      chapter.guide_id,
    ]);
    if (!guide) throw new Error('Guide not found.');

    await db().run('UPDATE guide_chapters SET completed_at = ?, updated_at = ? WHERE id = ?', [
      now,
      now,
      chapterId,
    ]);
    await db().run("UPDATE plan_items SET status = 'done' WHERE guide_chapter_id = ?", [chapterId]);

    const minutesMs = chapter.duration_ms ?? (chapter.word_count / 145) * 60_000;
    const minutes = Math.round((minutesMs / 60_000) * 10) / 10;
    await db().run(
      `INSERT INTO activity_events (id, kind, book_id, minutes, metadata_json, created_at)
       VALUES (?, 'guide', ?, ?, ?, ?)`,
      [
        newId('act'),
        guide.book_id,
        minutes,
        JSON.stringify({ guideId: guide.id, chapterId }),
        now,
      ],
    );

    const statuses = await db().all<{ status: string }>(
      'SELECT status FROM guide_chapters WHERE guide_id = ?',
      [guide.id],
    );
    const nextStatus = guideStatusFor(
      statuses.map((statusRow) => ({ status: statusRow.status as GuideChapterStatus })),
    );
    await db().run('UPDATE guides SET status = ?, updated_at = ? WHERE id = ?', [
      nextStatus,
      now,
      guide.id,
    ]);
  });
}

/** Re-open a chapter. Activity history is append-only and is never deleted. */
export async function uncompleteGuideChapter(chapterId: string): Promise<void> {
  const now = Date.now();
  await db().transaction(async () => {
    await db().run('UPDATE guide_chapters SET completed_at = NULL, updated_at = ? WHERE id = ?', [
      now,
      chapterId,
    ]);
    await db().run("UPDATE plan_items SET status = 'todo' WHERE guide_chapter_id = ?", [chapterId]);
  });
}

/** Delete a guide and its owned plan; returns segment file paths for the caller. */
export async function deleteGuide(id: string): Promise<string[]> {
  return db().transaction(async () => {
    const guide = await getGuide(id);
    if (!guide) return [];

    const paths = await db().all<{ file_path: string | null }>(
      `SELECT s.file_path
       FROM guide_chapter_segments s
       JOIN guide_chapters c ON c.id = s.guide_chapter_id
       WHERE c.guide_id = ? AND s.file_path IS NOT NULL`,
      [id],
    );

    await db().run('DELETE FROM guides WHERE id = ?', [id]);
    if (guide.planId) {
      await db().run('DELETE FROM plans WHERE id = ?', [guide.planId]);
    }

    return [...new Set(paths.map((row) => row.file_path).filter((path): path is string => !!path))];
  });
}
