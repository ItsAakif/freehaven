import { db } from '@/data/db';
import { newId, startOfDay } from '@/lib/id';
import { schedule } from '@/domain/fsrs';
import { logActivity } from './activity';
import type { Card, CardKind, Grade, Plan, PlanItem, Review, Summary, SummaryKind } from '@/domain/types';

/* -------------------------------------------------------------- summaries */

type SummaryRow = {
  id: string;
  book_id: string;
  kind: string;
  title: string;
  body_md: string;
  provider: string;
  model: string | null;
  section_id: string | null;
  created_at: number;
  updated_at: number;
};

function mapSummary(r: SummaryRow): Summary {
  return {
    id: r.id,
    bookId: r.book_id,
    kind: r.kind as SummaryKind,
    title: r.title,
    bodyMd: r.body_md,
    provider: r.provider,
    model: r.model,
    sectionId: r.section_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function saveSummary(input: {
  bookId: string;
  kind: SummaryKind;
  title: string;
  bodyMd: string;
  provider: string;
  model?: string | null;
  sectionId?: string | null;
  sourceChunkIds?: string[];
}): Promise<Summary> {
  const now = Date.now();
  const summary: Summary = {
    id: newId('sum'),
    bookId: input.bookId,
    kind: input.kind,
    title: input.title,
    bodyMd: input.bodyMd,
    provider: input.provider,
    model: input.model ?? null,
    sectionId: input.sectionId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db().transaction(async () => {
    await db().run(
      `INSERT INTO summaries (id, book_id, kind, title, body_md, provider, model, section_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        summary.id,
        summary.bookId,
        summary.kind,
        summary.title,
        summary.bodyMd,
        summary.provider,
        summary.model,
        summary.sectionId,
        summary.createdAt,
        summary.updatedAt,
      ],
    );
    for (const chunkId of input.sourceChunkIds ?? []) {
      await db().run('INSERT OR IGNORE INTO summary_sources (summary_id, chunk_id) VALUES (?,?)', [
        summary.id,
        chunkId,
      ]);
    }
  });
  await logActivity('lesson', { bookId: input.bookId, metadata: { kind: input.kind, sectionId: input.sectionId ?? null } });
  return summary;
}

export async function updateSummaryBody(id: string, bodyMd: string): Promise<void> {
  await db().run('UPDATE summaries SET body_md = ?, updated_at = ? WHERE id = ?', [
    bodyMd,
    Date.now(),
    id,
  ]);
}

export async function listSummaries(bookId: string): Promise<Summary[]> {
  const rows = await db().all<SummaryRow>(
    'SELECT * FROM summaries WHERE book_id = ? ORDER BY created_at DESC',
    [bookId],
  );
  return rows.map(mapSummary);
}
export async function getSummary(id: string): Promise<Summary | null> {
  const row = await db().first<SummaryRow>('SELECT * FROM summaries WHERE id = ?', [id]);
  return row ? mapSummary(row) : null;
}

export async function deleteSummary(id: string): Promise<void> {
  await db().run('DELETE FROM summaries WHERE id = ?', [id]);
}

export async function summarySourceChunks(summaryId: string): Promise<string[]> {
  const rows = await db().all<{ chunk_id: string }>(
    'SELECT chunk_id FROM summary_sources WHERE summary_id = ?',
    [summaryId],
  );
  return rows.map((r) => r.chunk_id);
}

export async function listRecentSummaries(limit = 5): Promise<(Summary & { bookTitle: string })[]> {
  const rows = await db().all<SummaryRow & { title_book: string | null }>(
    `SELECT s.*, b.title as title_book FROM summaries s LEFT JOIN books b ON b.id = s.book_id
     ORDER BY s.updated_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ ...mapSummary(r), bookTitle: r.title_book ?? 'Untitled' }));
}

/* ------------------------------------------------------------------ cards */

type CardRow = {
  id: string;
  book_id: string | null;
  front: string;
  back: string;
  kind: string;
  options_json: string | null;
  answer: string | null;
  explanation: string | null;
  source_chunk_id: string | null;
  state: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  due_at: number;
  last_review_at: number | null;
  created_at: number;
  updated_at: number;
};

function mapCard(r: CardRow): Card {
  return {
    id: r.id,
    bookId: r.book_id,
    front: r.front,
    back: r.back,
    kind: r.kind as CardKind,
    options: r.options_json ? (JSON.parse(r.options_json) as string[]) : null,
    answer: r.answer,
    explanation: r.explanation,
    sourceChunkId: r.source_chunk_id,
    state: r.state as Card['state'],
    stability: r.stability,
    difficulty: r.difficulty,
    reps: r.reps,
    lapses: r.lapses,
    dueAt: r.due_at,
    lastReviewAt: r.last_review_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function addCards(
  bookId: string | null,
  cards: {
    front: string;
    back: string;
    kind?: CardKind;
    options?: string[];
    answer?: string;
    explanation?: string;
    sourceChunkId?: string;
  }[],
): Promise<number> {
  const now = Date.now();
  let created = 0;
  await db().transaction(async () => {
    for (const card of cards) {
      await db().run(
        `INSERT INTO cards (id, book_id, front, back, kind, options_json, answer, explanation, source_chunk_id,
                            state, stability, difficulty, reps, lapses, due_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'new', 0, 0, 0, 0, ?, ?, ?)`,
        [
          newId('card'),
          bookId,
          card.front,
          card.back,
          card.kind ?? 'basic',
          card.options ? JSON.stringify(card.options) : null,
          card.answer ?? null,
          card.explanation ?? null,
          card.sourceChunkId ?? null,
          now,
          now,
          now,
        ],
      );
      created += 1;
    }
  });
  return created;
}

export async function updateCard(
  id: string,
  patch: Partial<Pick<Card, 'front' | 'back' | 'options' | 'answer' | 'explanation'>>,
): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.front !== undefined) {
    fields.push('front = ?');
    params.push(patch.front);
  }
  if (patch.back !== undefined) {
    fields.push('back = ?');
    params.push(patch.back);
  }
  if (patch.options !== undefined) {
    fields.push('options_json = ?');
    params.push(patch.options ? JSON.stringify(patch.options) : null);
  }
  if (patch.answer !== undefined) {
    fields.push('answer = ?');
    params.push(patch.answer);
  }
  if (patch.explanation !== undefined) {
    fields.push('explanation = ?');
    params.push(patch.explanation);
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  params.push(Date.now(), id);
  await db().run(`UPDATE cards SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function deleteCard(id: string): Promise<void> {
  await db().run('DELETE FROM cards WHERE id = ?', [id]);
}

export async function listCards(bookId?: string): Promise<Card[]> {
  const rows = bookId
    ? await db().all<CardRow>('SELECT * FROM cards WHERE book_id = ? ORDER BY created_at DESC', [bookId])
    : await db().all<CardRow>('SELECT * FROM cards ORDER BY created_at DESC LIMIT 500');
  return rows.map(mapCard);
}

export async function dueCards(now = Date.now(), limit = 50): Promise<Card[]> {
  const rows = await db().all<CardRow>(
    'SELECT * FROM cards WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?',
    [now, limit],
  );
  return rows.map(mapCard);
}

export async function dueCount(now = Date.now()): Promise<number> {
  const row = await db().first<{ count: number }>('SELECT COUNT(*) as count FROM cards WHERE due_at <= ?', [now]);
  return row?.count ?? 0;
}

export async function getCard(id: string): Promise<Card | null> {
  const row = await db().first<CardRow>('SELECT * FROM cards WHERE id = ?', [id]);
  return row ? mapCard(row) : null;
}

/** Apply a grade and persist both the card and an immutable review record. */
export async function reviewCard(
  cardId: string,
  rating: Grade,
  now = Date.now(),
): Promise<{ card: Card; review: Review }> {
  return db().transaction(async () => {
    const card = await getCard(cardId);
    if (!card) throw new Error('Card not found.');
    const next = schedule(card, rating, now);
    await db().run(
      `UPDATE cards SET state=?, stability=?, difficulty=?, reps=?, lapses=?, due_at=?, last_review_at=?, updated_at=?
       WHERE id=?`,
      [next.state, next.stability, next.difficulty, next.reps, next.lapses, next.dueAt, now, now, cardId],
    );
    const review: Review = {
      id: newId('rev'),
      cardId,
      rating,
      reviewedAt: now,
      elapsedDays: next.elapsedDays,
      scheduledDays: next.scheduledDays,
      stability: next.stability,
      difficulty: next.difficulty,
    };
    await db().run(
      `INSERT INTO reviews (id, card_id, rating, reviewed_at, elapsed_days, scheduled_days, stability, difficulty)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        review.id,
        review.cardId,
        review.rating,
        review.reviewedAt,
        review.elapsedDays,
        review.scheduledDays,
        review.stability,
        review.difficulty,
      ],
    );
    const updated = await getCard(cardId);
    if (!updated) throw new Error('Card disappeared during review.');
    await logActivity('review', {
      bookId: card.bookId ?? null,
      minutes: 0.5,
      metadata: { rating, cardId },
    });
    return { card: updated, review };
  });
}

export async function reviewStats(now = Date.now()): Promise<{
  due: number;
  reviewedToday: number;
  streakDays: number;
  last7Days: number[];
  totalCards: number;
  matureCards: number;
}> {
  const today = startOfDay(now);
  const reviewedTodayRow = await db().first<{ count: number }>(
    'SELECT COUNT(*) as count FROM reviews WHERE reviewed_at >= ?',
    [today],
  );
  const totalRow = await db().first<{ count: number }>('SELECT COUNT(*) as count FROM cards');
  const matureRow = await db().first<{ count: number }>(
    'SELECT COUNT(*) as count FROM cards WHERE state = ? AND stability >= 21',
    ['review'],
  );
  const days = await db().all<{ day: string }>(
    "SELECT DISTINCT date(reviewed_at / 1000, 'unixepoch', 'localtime') as day FROM reviews ORDER BY day DESC LIMIT 60",
  );
  const daySet = new Set(days.map((d) => d.day));
  let streak = 0;
  const cursor = new Date(today);
  for (let i = 0; i < 60; i += 1) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
      cursor.getDate(),
    ).padStart(2, '0')}`;
    if (!daySet.has(key)) {
      if (i === 0) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const last7: number[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    const row = await db().first<{ count: number }>(
      'SELECT COUNT(*) as count FROM reviews WHERE date(reviewed_at / 1000, \'unixepoch\', \'localtime\') = ?',
      [key],
    );
    last7.push(row?.count ?? 0);
  }
  return {
    due: await dueCount(now),
    reviewedToday: reviewedTodayRow?.count ?? 0,
    streakDays: streak,
    last7Days: last7,
    totalCards: totalRow?.count ?? 0,
    matureCards: matureRow?.count ?? 0,
  };
}

/* ------------------------------------------------------------------ plans */

export async function createPlan(title: string, goal?: string): Promise<Plan> {
  const plan: Plan = { id: newId('plan'), title: title.trim(), goal: goal?.trim() || null, createdAt: Date.now() };
  await db().run('INSERT INTO plans (id, title, goal, created_at) VALUES (?,?,?,?)', [
    plan.id,
    plan.title,
    plan.goal,
    plan.createdAt,
  ]);
  return plan;
}

export async function getPlan(id: string): Promise<Plan | null> {
  const row = await db().first<{ id: string; title: string; goal: string | null; created_at: number }>(
    'SELECT * FROM plans WHERE id = ?',
    [id],
  );
  if (!row) return null;
  return { id: row.id, title: row.title, goal: row.goal, createdAt: row.created_at };
}

export async function listPlans(): Promise<(Plan & { itemCount: number; doneCount: number })[]> {  const rows = await db().all<{ id: string; title: string; goal: string | null; created_at: number; item_count: number; done_count: number }>(
    `SELECT p.*, COUNT(i.id) as item_count, SUM(CASE WHEN i.status='done' THEN 1 ELSE 0 END) as done_count
     FROM plans p LEFT JOIN plan_items i ON i.plan_id = p.id GROUP BY p.id ORDER BY p.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    goal: r.goal,
    createdAt: r.created_at,
    itemCount: r.item_count ?? 0,
    doneCount: r.done_count ?? 0,
  }));
}

export async function addPlanItem(planId: string, bookId: string, ordinal: number): Promise<PlanItem> {
  const item: PlanItem = {
    id: newId('pi'),
    planId,
    bookId,
    ordinal,
    status: 'todo',
  };
  await db().run('INSERT INTO plan_items (id, plan_id, book_id, ordinal, status) VALUES (?,?,?,?,?)', [
    item.id,
    item.planId,
    item.bookId,
    item.ordinal,
    item.status,
  ]);
  return item;
}

export async function listPlanItems(planId: string): Promise<(PlanItem & { title: string; coverUrl: string | null })[]> {
  const rows = await db().all<{
    id: string;
    plan_id: string;
    book_id: string;
    ordinal: number;
    status: string;
    reason: string | null;
    title: string | null;
    cover_url: string | null;
  }>(
    `SELECT i.*, b.title, b.cover_url FROM plan_items i LEFT JOIN books b ON b.id = i.book_id
     WHERE i.plan_id = ? ORDER BY i.ordinal`,
    [planId],
  );
  return rows.map((r) => ({
    id: r.id,
    planId: r.plan_id,
    bookId: r.book_id,
    ordinal: r.ordinal,
    status: r.status as PlanItem['status'],
    reason: r.reason,
    title: r.title ?? 'Untitled',
    coverUrl: r.cover_url,
  }));
}

export async function setPlanItemStatus(id: string, status: PlanItem['status']): Promise<void> {
  await db().run('UPDATE plan_items SET status = ? WHERE id = ?', [status, id]);
}

/* ------------------------------------------------------------------- jobs */

export async function enqueueJob(type: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId('job');
  const now = Date.now();
  await db().run(
    `INSERT INTO jobs (id, type, payload_json, status, attempts, created_at, updated_at)
     VALUES (?,?,?,'queued',0,?,?)`,
    [id, type, JSON.stringify(payload), now, now],
  );
  return id;
}

export async function updateJob(
  id: string,
  status: 'queued' | 'running' | 'done' | 'failed',
  error?: string | null,
): Promise<void> {
  await db().run(
    `UPDATE jobs SET status = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    [status, error ?? null, Date.now(), id],
  );
}

export async function listActiveJobs(): Promise<{ id: string; type: string; status: string; error: string | null }[]> {
  return db().all(
    `SELECT id, type, status, error FROM jobs WHERE status IN ('queued','running','failed') ORDER BY created_at DESC LIMIT 20`,
  );
}

/** Remove library content and everything derived from it. Preferences survive. */
export async function deleteAllUserData(): Promise<void> {
  await db().transaction(async () => {
    await db().run('DELETE FROM audio_queue');
    await db().run('DELETE FROM books');
    await db().run('DELETE FROM documents');
    await db().run('DELETE FROM chunks');
    await db().run('DELETE FROM sections');
    await db().run('DELETE FROM highlights');
    await db().run('DELETE FROM bookmarks');
    await db().run('DELETE FROM bookmark_folders');
    await db().run('DELETE FROM reading_positions');
    await db().run('DELETE FROM summaries');
    await db().run('DELETE FROM cards');
    await db().run('DELETE FROM reviews');
    await db().run('DELETE FROM conversations');
    await db().run('DELETE FROM plans');
    await db().run('DELETE FROM jobs');
    await db().run('DELETE FROM downloads');
    await db().run('DELETE FROM topics');
    await db().run('DELETE FROM activity_events');
    await db().run('DELETE FROM user_profile');
  });
}

/** Row counts for the storage summary in Settings. */
export async function dataCounts(): Promise<Record<string, number>> {
  const tables = ['books', 'documents', 'chunks', 'highlights', 'cards', 'reviews', 'summaries', 'conversations'];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = await db().first<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`);
    out[table] = row?.count ?? 0;
  }
  return out;
}
