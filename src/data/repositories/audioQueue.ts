import { db } from '@/data/db';
import { newId } from '@/lib/id';

export type QueueItem = {
  id: string;
  bookId: string;
  sectionId: string;
  ordinal: number;
  title: string | null;
  status: 'queued' | 'ready' | 'playing' | 'done';
  filePath: string | null;
  duration: number | null;
};

type Row = {
  id: string;
  book_id: string;
  section_id: string;
  ordinal: number;
  title: string | null;
  status: string;
  file_path: string | null;
  duration: number | null;
};

function map(r: Row): QueueItem {
  return {
    id: r.id,
    bookId: r.book_id,
    sectionId: r.section_id,
    ordinal: r.ordinal,
    title: r.title,
    status: r.status as QueueItem['status'],
    filePath: r.file_path,
    duration: r.duration,
  };
}

/** Reconcile the persisted queue with the current section list, preserving status. */
export async function syncQueue(
  bookId: string,
  sections: { id: string; title?: string | null }[],
): Promise<QueueItem[]> {
  const existing = await listQueue(bookId);
  const bySection = new Map(existing.map((item) => [item.sectionId, item]));
  const now = Date.now();
  await db().transaction(async () => {
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const found = bySection.get(section.id);
      if (found) {
        await db().run('UPDATE audio_queue SET ordinal = ?, title = ? WHERE id = ?', [
          i,
          section.title ?? null,
          found.id,
        ]);
      } else {
        await db().run(
          `INSERT INTO audio_queue (id, book_id, section_id, ordinal, title, status, created_at, updated_at)
           VALUES (?,?,?,?,?,'queued',?,?)`,
          [newId('aq'), bookId, section.id, i, section.title ?? null, now, now],
        );
      }
    }
    const valid = new Set(sections.map((s) => s.id));
    for (const item of existing) {
      if (!valid.has(item.sectionId)) await db().run('DELETE FROM audio_queue WHERE id = ?', [item.id]);
    }
  });
  return listQueue(bookId);
}

export async function listQueue(bookId: string): Promise<QueueItem[]> {
  const rows = await db().all<Row>('SELECT * FROM audio_queue WHERE book_id = ? ORDER BY ordinal', [bookId]);
  return rows.map(map);
}

export async function markQueueItem(
  id: string,
  patch: Partial<Pick<QueueItem, 'status' | 'filePath' | 'duration'>>,
): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    params.push(patch.status);
  }
  if (patch.filePath !== undefined) {
    fields.push('file_path = ?');
    params.push(patch.filePath);
  }
  if (patch.duration !== undefined) {
    fields.push('duration = ?');
    params.push(patch.duration);
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  params.push(Date.now(), id);
  await db().run(`UPDATE audio_queue SET ${fields.join(', ')} WHERE id = ?`, params);
}

export function nextQueueIndex(items: QueueItem[], current: number): number {
  if (!items.length) return 0;
  for (let i = current + 1; i < items.length; i += 1) {
    if (items[i].status !== 'done') return i;
  }
  return Math.min(items.length - 1, current + 1);
}
