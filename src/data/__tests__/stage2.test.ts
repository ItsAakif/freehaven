/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { familiarityScore, getProfile, saveProfile } from '@/data/repositories/profile';
import { logActivity, minutesByDay, minutesToday, readingMinutes } from '@/data/repositories/activity';
import {
  addCards,
  addPlanItem,
  createPlan,
  listPlanItems,
  listSummaries,
  reviewCard,
  saveSummary,
} from '@/data/repositories/learning';
import { bookMastery, rebuildPlanSequence, topicMastery } from '@/data/repositories/mastery';
import {
  addBookmark,
  createBookmarkFolder,
  listBookmarksWithBooks,
  updateBookmark,
} from '@/data/repositories/reading';
import { attachTopics, upsertCatalogueBook } from '@/data/repositories/books';

const candidate = (id: string, title: string, pages = 200) => ({
  id,
  provider: 'gutendex',
  title,
  author: 'Author',
  pageCount: pages,
  subjects: [],
  source: 'gutenberg' as const,
  sourceId: id,
  access: 'public_domain' as const,
});

describe('profile, activity and mastery', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* closed */
    }
  });

  it('stores a profile with display name, goal, topics and familiarity', async () => {
    const saved = await saveProfile({
      displayName: 'Aakif',
      goal: 'think clearly',
      topics: ['philosophy', 'psychology'],
      familiarity: { philosophy: 'new', psychology: 'confident' },
      minutesPerDay: 20,
      onboardingComplete: true,
    });
    expect(saved.displayName).toBe('Aakif');
    const loaded = await getProfile();
    expect(loaded.topics).toEqual(['philosophy', 'psychology']);
    expect(loaded.familiarity.psychology).toBe('confident');
    expect(loaded.minutesPerDay).toBe(20);
    expect(familiarityScore(loaded, 'philosophy')).toBe(1);
    expect(familiarityScore(loaded, 'psychology')).toBe(3);
    expect(familiarityScore(loaded, 'unknown')).toBe(2);
  });

  it('aggregates study minutes and daily buckets', async () => {
    await logActivity('read', { minutes: 3.5 });
    await logActivity('review', { minutes: 0.5 });
    expect(await minutesToday()).toBe(4);
    const days = await minutesByDay(7);
    expect(days).toHaveLength(7);
    expect(days[6].minutes).toBe(4);
    expect(readingMinutes(1000, 0.1)).toBeCloseTo(0.5, 1);
    expect(readingMinutes(null, 0.5)).toBe(0);
  });

  it('computes per-book and per-topic mastery', async () => {
    await upsertCatalogueBook(candidate('phil:1', 'Meditations'));
    await attachTopics('phil:1', ['philosophy']);
    await addCards('phil:1', [
      { front: 'What is virtue?', back: 'Excellence of character.' },
      { front: 'Who wrote this?', back: 'Marcus Aurelius.' },
    ]);
    const due = await driver.all<{ id: string }>('SELECT id FROM cards');
    await reviewCard(due[0].id, 4);
    const mastery = await bookMastery('phil:1');
    expect(mastery.cards).toBe(2);
    expect(mastery.avgStability).toBeGreaterThan(0);
    const topics = await topicMastery();
    expect(topics[0].topic).toBe('philosophy');
    expect(topics[0].cards).toBe(2);
  });

  it('orders a path by self-assessed familiarity, then progress, then length', async () => {
    await saveProfile({
      displayName: 'Aakif',
      goal: null,
      topics: ['philosophy', 'economics'],
      familiarity: { philosophy: 'new', economics: 'confident' },
      minutesPerDay: 15,
      onboardingComplete: true,
    });
    await upsertCatalogueBook(candidate('econ:1', 'Economics', 500));
    await upsertCatalogueBook(candidate('phil:1', 'Philosophy', 300));
    await upsertCatalogueBook(candidate('phil:2', 'Short Philosophy', 120));
    await attachTopics('econ:1', ['economics']);
    await attachTopics('phil:1', ['philosophy']);
    await attachTopics('phil:2', ['philosophy']);
    const plan = await createPlan('Understand things', 'start');
    await addPlanItem(plan.id, 'econ:1', 0);
    await addPlanItem(plan.id, 'phil:1', 1);
    await addPlanItem(plan.id, 'phil:2', 2);

    await rebuildPlanSequence(plan.id);

    const items = await listPlanItems(plan.id);
    expect(items.map((i) => i.title)).toEqual(['Short Philosophy', 'Philosophy', 'Economics']);
    expect(items[0].reason).toMatch(/rated this topic new/);
  });

  it('stores a chapter-scoped summary', async () => {
    await upsertCatalogueBook(candidate('b1', 'Book'));
    const summary = await saveSummary({
      bookId: 'b1',
      kind: 'chapter',
      title: 'Chapter 2',
      bodyMd: 'Chapter summary.',
      provider: 'extractive',
      sectionId: 's2',
    });
    const all = await listSummaries('b1');
    expect(all[0].sectionId).toBe('s2');
    expect(summary.kind).toBe('chapter');
  });

  it('groups bookmarks by folder and keeps tags searchable', async () => {
    await upsertCatalogueBook(candidate('b1', 'Book'));
    const folder = await createBookmarkFolder('Thesis', 'gold');
    const bookmark = await addBookmark('b1', '{}', 'Key passage', {
      folderId: folder.id,
      tags: ['attention', 'memory'],
    });
    const withMeta = await listBookmarksWithBooks();
    expect(withMeta[0].folderName).toBe('Thesis');
    expect(withMeta[0].tags).toEqual(['attention', 'memory']);
    await updateBookmark(bookmark.id, { tags: ['memory'], folderId: null });
    const updated = await listBookmarksWithBooks();
    expect(updated[0].tags).toEqual(['memory']);
    expect(updated[0].folderName).toBeNull();
  });
});
