import { db } from '@/data/db';
import { logActivity } from './activity';
import { familiarityScore, getProfile, type Profile } from './profile';

export type BookMastery = {
  bookId: string;
  cards: number;
  mature: number;
  due: number;
  avgStability: number;
  lastReviewedAt: number | null;
};

export async function bookMastery(bookId: string): Promise<BookMastery> {
  const row = await db().first<{
    cards: number;
    mature: number;
    due: number;
    avg_stability: number | null;
    last_reviewed: number | null;
  }>(
    `SELECT COUNT(*) as cards,
            SUM(CASE WHEN state = 'review' AND stability >= 21 THEN 1 ELSE 0 END) as mature,
            SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) as due,
            AVG(stability) as avg_stability,
            MAX(last_review_at) as last_reviewed
     FROM cards WHERE book_id = ?`,
    [Date.now(), bookId],
  );
  return {
    bookId,
    cards: row?.cards ?? 0,
    mature: row?.mature ?? 0,
    due: row?.due ?? 0,
    avgStability: Math.round((row?.avg_stability ?? 0) * 10) / 10,
    lastReviewedAt: row?.last_reviewed ?? null,
  };
}

export type TopicMastery = {
  topic: string;
  books: number;
  cards: number;
  mature: number;
  due: number;
  avgStability: number;
};

/** Mastery grouped by the topics attached to books (from onboarding or paths). */
export async function topicMastery(): Promise<TopicMastery[]> {
  const rows = await db().all<{
    topic: string;
    books: number;
    cards: number;
    mature: number;
    due: number;
    avg_stability: number | null;
  }>(
    `SELECT t.name as topic,
            COUNT(DISTINCT bt.book_id) as books,
            COUNT(c.id) as cards,
            SUM(CASE WHEN c.state = 'review' AND c.stability >= 21 THEN 1 ELSE 0 END) as mature,
            SUM(CASE WHEN c.due_at <= ? THEN 1 ELSE 0 END) as due,
            AVG(c.stability) as avg_stability
     FROM topics t
     JOIN book_topics bt ON bt.topic_id = t.id
     LEFT JOIN cards c ON c.book_id = bt.book_id
     GROUP BY t.name
     ORDER BY mature DESC, cards DESC`,
    [Date.now()],
  );
  return rows.map((r) => ({
    topic: r.topic,
    books: r.books ?? 0,
    cards: r.cards ?? 0,
    mature: r.mature ?? 0,
    due: r.due ?? 0,
    avgStability: Math.round((r.avg_stability ?? 0) * 10) / 10,
  }));
}

type SequenceCandidate = {
  id: string;
  bookId: string;
  status: 'todo' | 'doing' | 'done';
  title: string;
  pageCount: number | null;
  percent: number;
  familiarity: number;
  topics: string[];
};

/**
 * Rule-based adaptive ordering, explicitly explainable:
 *   1. topics you rated least familiar first,
 *   2. books you have already started next,
 *   3. shorter books before longer ones to build momentum.
 * This is not a claim of machine-learned adaptation; the reason string is shown
 * in the UI so the ordering is never opaque.
 */
export async function rebuildPlanSequence(planId: string, profile?: Profile): Promise<void> {
  const activeProfile = profile ?? (await getProfile());
  const items = await db().all<{
    id: string;
    book_id: string;
    status: string;
    title: string | null;
    page_count: number | null;
    percent: number | null;
  }>(
    `SELECT i.id, i.book_id, i.status, b.title, b.page_count, p.percent
     FROM plan_items i
     LEFT JOIN books b ON b.id = i.book_id
     LEFT JOIN reading_positions p ON p.book_id = i.book_id
     WHERE i.plan_id = ?`,
    [planId],
  );
  const topicRows = await db().all<{ book_id: string; name: string }>(
    `SELECT bt.book_id, t.name FROM book_topics bt JOIN topics t ON t.id = bt.topic_id`,
  );
  const topicsByBook = new Map<string, string[]>();
  for (const row of topicRows) {
    topicsByBook.set(row.book_id, [...(topicsByBook.get(row.book_id) ?? []), row.name]);
  }

  const candidates: SequenceCandidate[] = items.map((item) => {
    const topics = topicsByBook.get(item.book_id) ?? [];
    const familiarity = topics.length
      ? Math.min(...topics.map((topic) => familiarityScore(activeProfile, topic)))
      : 2;
    return {
      id: item.id,
      bookId: item.book_id,
      status: item.status as SequenceCandidate['status'],
      title: item.title ?? 'Untitled',
      pageCount: item.page_count,
      percent: item.percent ?? 0,
      familiarity,
      topics,
    };
  });

  candidates.sort((a, b) => {
    if (a.familiarity !== b.familiarity) return a.familiarity - b.familiarity;
    if (a.percent === 0 && b.percent > 0) return -1;
    if (b.percent === 0 && a.percent > 0) return 1;
    return (a.pageCount ?? 9999) - (b.pageCount ?? 9999);
  });

  await db().transaction(async () => {
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const reason =
        candidate.familiarity === 1
          ? 'You rated this topic new — start here'
          : candidate.percent > 0
            ? 'Continue where you left off'
            : (candidate.pageCount ?? 9999) <= 250
              ? 'A short read to build momentum'
              : 'Builds on the earlier books';
      await db().run('UPDATE plan_items SET ordinal = ?, reason = ? WHERE id = ?', [i, reason, candidate.id]);
    }
  });

  await logActivity('plan', {
    metadata: { planId, action: 'resequence', items: candidates.length },
  });
}

/** A compact "what changed" feed for the plan screen. */
export function sequenceSummary(profile: Profile): string {
  if (!profile.topics.length) return 'Add topics in onboarding to personalise the order.';
  return `Prioritising ${profile.topics.slice(0, 3).join(', ')} at your current level.`;
}
