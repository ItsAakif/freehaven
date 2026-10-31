/** @jest-environment node */
import { migrate, resetDriverForTests, setDriverForTests } from '@/data/db';
import { MIGRATION_1, MIGRATIONS } from '@/data/schema';
import { createTestDriver } from '@/data/__tests__/testDriver';
import {
  completeGuideChapter,
  deleteGuide,
  getGuide,
  getGuideChapter,
  getOrCreateGuide,
  guideForToday,
  guideStats,
  listGuideChapterSegments,
  listGuideChapters,
  listGuides,
  replaceGuideChapterSegments,
  replaceGuideChapters,
  setGuideChapterAudio,
  setGuideChapterStatus,
  uncompleteGuideChapter,
  updateGuideChapterScript,
  updateGuideChapterSegment,
} from '@/data/repositories/guides';
import { addPlanItem, createPlan, listPlanItems } from '@/data/repositories/learning';
import type { QueuedSegment } from '@/domain/narration';

const BOOK_ID = 'b1';
const BOOK_TITLE = 'The Psychology of Money';

function segment(text: string, speechKey: string): QueuedSegment {
  return {
    sectionId: null,
    sectionOrdinal: 0,
    title: null,
    text,
    speechKey,
  };
}

describe('guide repository', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      [BOOK_ID, BOOK_TITLE, 'import', 'user_import', 0, 0],
    );
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  async function makeGuide(chapters = 2) {
    const guide = await getOrCreateGuide({
      bookId: BOOK_ID,
      title: BOOK_TITLE,
      styleId: 'fireside',
      language: 'en',
      engine: 'device',
      voice: null,
      model: null,
    });
    const rows = await replaceGuideChapters(
      guide.id,
      Array.from({ length: chapters }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        startPage: index * 10 + 1,
        endPage: index * 10 + 10,
        sectionIds: [`sec-${index * 10 + 1}`, `sec-${index * 10 + 2}`],
      })),
    );
    return { guide: (await getGuide(guide.id))!, chapters: rows };
  }

  it('migrates a v7 database to v8 and is idempotent', async () => {
    await driver.close();
    driver = createTestDriver();
    await driver.exec(MIGRATION_1);
    for (const migration of MIGRATIONS.filter(
      (candidate) => candidate.version > 1 && candidate.version <= 7,
    )) {
      await driver.exec(migration.sql);
    }
    await driver.exec('PRAGMA user_version = 7');
    expect(await migrate(driver)).toBe(8);
    expect(await migrate(driver)).toBe(8);
    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const expected of ['guides', 'guide_chapters', 'guide_chapter_segments']) {
      expect(tables.map((table) => table.name)).toContain(expected);
    }
  });

  it('cascades book → guide → chapter → segment → plan item', async () => {
    const { guide, chapters } = await makeGuide(2);
    await replaceGuideChapterSegments(chapters[0].id, [segment('hello', 'k0')]);
    const planItems = await listPlanItems(guide.planId as string);
    expect(planItems).toHaveLength(2);

    await driver.run('DELETE FROM books WHERE id = ?', [BOOK_ID]);
    expect(await driver.all('SELECT * FROM guides')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM guide_chapters')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM guide_chapter_segments')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM plan_items')).toHaveLength(0);
  });

  it('rejects a second plan item with the same non-null guide_chapter_id', async () => {
    const { guide, chapters } = await makeGuide(1);
    await expect(
      driver.run(
        `INSERT INTO plan_items (id, plan_id, book_id, ordinal, status, guide_chapter_id)
         VALUES ('dupe', ?, ?, 9, 'todo', ?)`,
        [guide.planId, BOOK_ID, chapters[0].id],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('getOrCreateGuide returns one row per tuple and a different row per style', async () => {
    const first = await getOrCreateGuide({
      bookId: BOOK_ID,
      title: BOOK_TITLE,
      styleId: 'fireside',
      language: 'en',
      engine: 'device',
      voice: null,
      model: null,
    });
    const second = await getOrCreateGuide({
      bookId: BOOK_ID,
      title: 'Another title is ignored',
      styleId: 'fireside',
      language: 'en',
      engine: 'remote',
      voice: 'nova',
      model: 'tts-1',
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(BOOK_TITLE);
    expect(second.engine).toBe('device');
    expect(second.wordsPerChapter).toBe(250);
    expect(second.chaptersPerDay).toBe(1);
    expect(second.status).toBe('draft');

    const other = await getOrCreateGuide({
      bookId: BOOK_ID,
      title: BOOK_TITLE,
      styleId: 'brief',
      language: 'en',
      engine: 'device',
      voice: null,
      model: null,
    });
    expect(other.id).not.toBe(first.id);
    expect(await listGuides(BOOK_ID)).toHaveLength(2);
  });

  it('replaceGuideChapters writes one dense guide plan and is idempotent', async () => {
    const guide = await getOrCreateGuide({
      bookId: BOOK_ID,
      title: BOOK_TITLE,
      styleId: 'fireside',
      language: 'en',
      engine: 'device',
      voice: null,
      model: null,
    });
    const chapters = await replaceGuideChapters(
      guide.id,
      Array.from({ length: 3 }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        startPage: index + 1,
        endPage: index + 1,
        sectionIds: [`sec-${index + 1}`],
      })),
    );

    const stored = (await getGuide(guide.id))!;
    expect(stored.status).toBe('ready');
    expect(stored.planId).toBeTruthy();
    expect(chapters.map((chapter) => chapter.ordinal)).toEqual([0, 1, 2]);
    expect(chapters.map((chapter) => chapter.sectionIds)).toEqual([
      ['sec-1'],
      ['sec-2'],
      ['sec-3'],
    ]);

    const plan = await driver.first<{ title: string; goal: string }>(
      'SELECT title, goal FROM plans WHERE id = ?',
      [stored.planId],
    );
    expect(plan).toMatchObject({
      title: `${BOOK_TITLE} · Full guide`,
      goal: '3 chapters, one a day',
    });
    let items = await listPlanItems(stored.planId as string);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.ordinal)).toEqual([0, 1, 2]);
    expect(items.map((item) => item.guideChapterId)).toEqual(chapters.map((c) => c.id));

    const again = await replaceGuideChapters(
      guide.id,
      chapters.map((chapter) => ({
        title: chapter.title,
        startPage: chapter.startPage,
        endPage: chapter.endPage,
        sectionIds: chapter.sectionIds,
      })),
    );
    expect(again).toHaveLength(3);
    expect((await getGuide(guide.id))!.planId).toBe(stored.planId);
    items = await listPlanItems(stored.planId as string);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.guideChapterId)).toEqual(again.map((c) => c.id));

    await expect(replaceGuideChapters(guide.id, [])).rejects.toThrow(
      'Guide needs at least one chapter',
    );
  });

  it('reconciles guide segments by ordinal, speech key and text', async () => {
    const { chapters } = await makeGuide(1);
    const chapterId = chapters[0].id;

    const initial = await replaceGuideChapterSegments(chapterId, [
      segment('alpha', 'k0'),
      segment('beta', 'k1'),
      segment('gamma', 'k2'),
    ]);
    expect(initial).toHaveLength(3);
    expect(initial.map((entry) => entry.status)).toEqual(['queued', 'queued', 'queued']);

    await updateGuideChapterSegment(initial[0].id, {
      status: 'ready',
      filePath: '/audio/0.wav',
      format: 'wav',
      durationMs: 1_500,
      bytes: 12,
    });

    const reconciled = await replaceGuideChapterSegments(chapterId, [
      segment('alpha', 'k0'),
      segment('beta changed', 'k1'),
      segment('delta', 'k3'),
    ]);
    expect(reconciled).toHaveLength(3);
    expect(reconciled[0]).toMatchObject({
      text: 'alpha',
      filePath: '/audio/0.wav',
      durationMs: 1_500,
      status: 'ready',
    });
    expect(reconciled[1]).toMatchObject({
      text: 'beta changed',
      filePath: null,
      durationMs: null,
      status: 'queued',
    });
    expect(reconciled[2]).toMatchObject({ text: 'delta', status: 'queued' });

    const shortened = await replaceGuideChapterSegments(chapterId, [
      segment('alpha', 'k0'),
      segment('delta', 'k3'),
    ]);
    expect(shortened.map((entry) => entry.text)).toEqual(['alpha', 'delta']);
    expect(await listGuideChapterSegments(chapterId)).toHaveLength(2);
  });

  it('guideForToday follows the daily path and never skips a blocked chapter', async () => {
    const { chapters } = await makeGuide(2);
    await setGuideChapterStatus(chapters[0].id, 'ready');
    await setGuideChapterStatus(chapters[1].id, 'ready');

    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();

    const next = await guideForToday(now);
    expect(next?.kind).toBe('next');
    if (next?.kind === 'next') {
      expect(next.chapter.id).toBe(chapters[0].id);
      expect(next.total).toBe(2);
      expect(next.done).toBe(0);
      expect(next.streakDays).toBe(0);
    }

    await completeGuideChapter(chapters[0].id, now);
    const doneToday = await guideForToday(now);
    expect(doneToday?.kind).toBe('done_today');
    if (doneToday?.kind === 'done_today') {
      expect(doneToday.next?.id).toBe(chapters[1].id);
      expect(doneToday.completedToday).toBe(1);
      expect(doneToday.done).toBe(1);
      expect(doneToday.streakDays).toBe(1);
    }

    await completeGuideChapter(chapters[1].id, now);
    const complete = await guideForToday(now);
    expect(complete?.kind).toBe('complete');
    if (complete?.kind === 'complete') {
      expect(complete.done).toBe(2);
      expect(complete.total).toBe(2);
      expect(complete.streakDays).toBe(1);
    }
  });

  it('never skips a blocked earlier chapter in the daily path', async () => {
    const guide = await getOrCreateGuide({
      bookId: BOOK_ID,
      title: BOOK_TITLE,
      styleId: 'brief',
      language: 'en',
      engine: 'device',
      voice: null,
      model: null,
    });
    const chapters = await replaceGuideChapters(guide.id, [
      { title: 'Blocked', startPage: 1, endPage: 10, sectionIds: ['sec-1'] },
      { title: 'Hidden', startPage: 11, endPage: 20, sectionIds: ['sec-2'] },
    ]);
    await setGuideChapterStatus(chapters[0].id, 'failed', 'no_sections');
    await setGuideChapterStatus(chapters[1].id, 'ready');

    expect(await guideForToday()).toBeNull();
    expect((await getGuideChapter(chapters[1].id))!.status).toBe('ready');
  });

  it('honours chapters_per_day above one', async () => {
    const { guide, chapters } = await makeGuide(2);
    await driver.run('UPDATE guides SET chapters_per_day = 2 WHERE id = ?', [guide.id]);
    await setGuideChapterStatus(chapters[0].id, 'ready');
    await setGuideChapterStatus(chapters[1].id, 'ready');
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();

    await completeGuideChapter(chapters[0].id, now);
    const today = await guideForToday(now);
    expect(today?.kind).toBe('next');
    if (today?.kind === 'next') expect(today.chapter.id).toBe(chapters[1].id);
  });

  it('completeGuideChapter is idempotent and logs exactly one guide activity', async () => {
    const { guide, chapters } = await makeGuide(1);
    const chapter = chapters[0];
    await setGuideChapterStatus(chapter.id, 'ready');
    await setGuideChapterAudio(chapter.id, {
      audioPath: null,
      durationMs: 120_000,
      timingsJson: null,
    });

    const now = new Date(2026, 10, 1, 9, 0, 0).getTime();
    await completeGuideChapter(chapter.id, now);
    await completeGuideChapter(chapter.id, now);

    const activity = await driver.all<{
      kind: string;
      book_id: string;
      minutes: number;
      metadata_json: string;
    }>("SELECT kind, book_id, minutes, metadata_json FROM activity_events WHERE kind = 'guide'");
    expect(activity).toHaveLength(1);
    expect(activity[0].book_id).toBe(BOOK_ID);
    expect(activity[0].minutes).toBe(2);
    expect(JSON.parse(activity[0].metadata_json)).toEqual({
      guideId: guide.id,
      chapterId: chapter.id,
    });

    expect((await getGuideChapter(chapter.id))!.completedAt).toBe(now);
    const items = await listPlanItems(guide.planId as string);
    expect(items[0].status).toBe('done');

    await uncompleteGuideChapter(chapter.id);
    expect((await getGuideChapter(chapter.id))!.completedAt).toBeNull();
    expect((await listPlanItems(guide.planId as string))[0].status).toBe('todo');
    expect(
      await driver.all("SELECT * FROM activity_events WHERE kind = 'guide'"),
    ).toHaveLength(1);
  });

  it('guideStats aggregates chapters, words, duration and streak', async () => {
    const { guide, chapters } = await makeGuide(2);
    await updateGuideChapterScript(chapters[0].id, {
      summaryMd: 'one',
      wordCount: 250,
      provider: 'fake',
      model: null,
      status: 'ready',
    });
    await setGuideChapterAudio(chapters[0].id, {
      audioPath: null,
      durationMs: 60_000,
      timingsJson: null,
    });
    await updateGuideChapterScript(chapters[1].id, {
      summaryMd: 'two',
      wordCount: 300,
      provider: 'fake',
      model: null,
      status: 'ready',
    });
    await setGuideChapterAudio(chapters[1].id, {
      audioPath: null,
      durationMs: 90_000,
      timingsJson: null,
    });

    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();
    await completeGuideChapter(chapters[0].id, now);

    expect(await guideStats(guide.id, now)).toEqual({
      chapters: 2,
      ready: 2,
      completed: 1,
      words: 550,
      durationMs: 150_000,
      streakDays: 1,
    });
  });

  it('deleteGuide returns segment paths and removes the guide-owned plan', async () => {
    const { guide, chapters } = await makeGuide(2);
    const segments = await replaceGuideChapterSegments(chapters[0].id, [
      segment('alpha', 'k0'),
      segment('beta', 'k1'),
    ]);
    await updateGuideChapterSegment(segments[0].id, {
      status: 'ready',
      filePath: '/audio/0.wav',
      format: 'wav',
    });
    await updateGuideChapterSegment(segments[1].id, {
      status: 'ready',
      filePath: '/audio/1.wav',
      format: 'wav',
    });

    const paths = await deleteGuide(guide.id);
    expect(paths.sort()).toEqual(['/audio/0.wav', '/audio/1.wav']);
    expect(await getGuide(guide.id)).toBeNull();
    expect(await listGuideChapters(guide.id)).toHaveLength(0);
    expect(await driver.all('SELECT * FROM plans WHERE id = ?', [guide.planId])).toHaveLength(0);
    expect(await driver.all('SELECT * FROM plan_items WHERE plan_id = ?', [guide.planId])).toHaveLength(0);
  });

  it('listPlanItems exposes the guide chapter and keeps book plans unchanged', async () => {
    const { guide, chapters } = await makeGuide(1);
    await setGuideChapterStatus(chapters[0].id, 'ready');
    await setGuideChapterAudio(chapters[0].id, {
      audioPath: null,
      durationMs: 42_000,
      timingsJson: null,
    });

    const items = await listPlanItems(guide.planId as string);
    expect(items[0]).toMatchObject({
      guideChapterId: chapters[0].id,
      guideChapterTitle: 'Chapter 1',
      guideChapterStatus: 'ready',
      guideId: guide.id,
      guideTitle: BOOK_TITLE,
      guideDurationMs: 42_000,
    });

    const bookPlan = await createPlan('Book plan', 'Read it');
    await addPlanItem(bookPlan.id, BOOK_ID, 0);
    const bookItems = await listPlanItems(bookPlan.id);
    expect(bookItems).toHaveLength(1);
    expect(bookItems[0]).toMatchObject({
      title: BOOK_TITLE,
      guideChapterId: null,
      guideChapterTitle: null,
      guideChapterStatus: null,
      guideId: null,
      guideTitle: null,
      guideDurationMs: null,
    });
  });
});
