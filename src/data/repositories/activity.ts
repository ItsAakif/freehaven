import { db } from '@/data/db';
import { newId, startOfDay } from '@/lib/id';

export type ActivityKind = 'read' | 'listen' | 'review' | 'highlight' | 'lesson' | 'chat' | 'import' | 'bookmark' | 'plan';

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  bookId: string | null;
  minutes: number;
  metadata: Record<string, unknown> | null;
  createdAt: number;
};

export async function logActivity(
  kind: ActivityKind,
  options: { bookId?: string | null; minutes?: number; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const minutes = Math.max(0, options.minutes ?? 0);
  await db().run(
    `INSERT INTO activity_events (id, kind, book_id, minutes, metadata_json, created_at) VALUES (?,?,?,?,?,?)`,
    [
      newId('act'),
      kind,
      options.bookId ?? null,
      minutes,
      options.metadata ? JSON.stringify(options.metadata) : null,
      Date.now(),
    ],
  );
}

export async function listActivity(limit = 60): Promise<(ActivityEvent & { bookTitle: string | null })[]> {
  const rows = await db().all<{
    id: string;
    kind: string;
    book_id: string | null;
    minutes: number;
    metadata_json: string | null;
    created_at: number;
    title: string | null;
  }>(
    `SELECT a.*, b.title FROM activity_events a LEFT JOIN books b ON b.id = a.book_id
     ORDER BY a.created_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ActivityKind,
    bookId: r.book_id,
    minutes: r.minutes,
    metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
    bookTitle: r.title,
  }));
}

export async function minutesToday(now = Date.now()): Promise<number> {
  const row = await db().first<{ total: number | null }>(
    'SELECT SUM(minutes) as total FROM activity_events WHERE created_at >= ?',
    [startOfDay(now)],
  );
  return Math.round((row?.total ?? 0) * 10) / 10;
}

export async function minutesByDay(days = 7, now = Date.now()): Promise<{ day: number; minutes: number }[]> {
  const out: { day: number; minutes: number }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = startOfDay(now - i * 86_400_000);
    const end = start + 86_400_000;
    const row = await db().first<{ total: number | null }>(
      'SELECT SUM(minutes) as total FROM activity_events WHERE created_at >= ? AND created_at < ?',
      [start, end],
    );
    out.push({ day: start, minutes: Math.round((row?.total ?? 0) * 10) / 10 });
  }
  return out;
}

/**
 * Reading minutes from a position delta: the only honest way to estimate time
 * spent without tracking every scroll. Uses the document's word count.
 */
export function readingMinutes(wordCount: number | null, percentDelta: number): number {
  if (!wordCount || percentDelta <= 0) return 0;
  const words = wordCount * Math.min(1, percentDelta);
  return Math.max(0.1, Math.round((words / 220) * 10) / 10);
}

export async function activityCounts(now = Date.now()): Promise<Record<string, number>> {
  const rows = await db().all<{ kind: string; count: number }>(
    'SELECT kind, COUNT(*) as count FROM activity_events WHERE created_at >= ? GROUP BY kind',
    [startOfDay(now)],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r.count]));
}
