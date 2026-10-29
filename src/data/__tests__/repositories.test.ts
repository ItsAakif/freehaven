/** @jest-environment node */
import { migrate, resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import {
  getBook,
  listLibrary,
  setInLibrary,
  upsertCatalogueBook,
} from '@/data/repositories/books';
import {
  addHighlight,
  deleteHighlight,
  listHighlights,
  listHighlightsWithBooks,
  updateHighlightNote,
} from '@/data/repositories/reading';
import {
  addCards,
  deleteAllUserData,
  dueCards,
  listSummaries,
  reviewCard,
  saveSummary,
  summarySourceChunks,
} from '@/data/repositories/learning';
import { addMessage, createConversation, listMessages } from '@/data/repositories/mindspace';

const candidate = {
  id: 'gutendex:1342',
  provider: 'gutendex',
  title: 'Pride and Prejudice',
  author: 'Jane Austen',
  subjects: ['fiction'],
  source: 'gutenberg' as const,
  sourceId: '1342',
  access: 'public_domain' as const,
  license: 'Public domain (Project Gutenberg)',
  epubUrl: 'https://example.org/1342.epub',
  externalUrl: 'https://www.gutenberg.org/ebooks/1342',
};

describe('repositories', () => {
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
      /* already closed */
    }
  });

  it('upserts catalogue metadata without losing library membership', async () => {
    await upsertCatalogueBook(candidate);
    await setInLibrary(candidate.id, true);
    await upsertCatalogueBook({ ...candidate, title: 'Pride and Prejudice (revised)' });
    const book = await getBook(candidate.id);
    expect(book?.title).toBe('Pride and Prejudice (revised)');
    expect(book?.inLibrary).toBe(true);
    expect(await listLibrary()).toHaveLength(1);
  });

  it('stores highlights with notes and joins the book title', async () => {
    await upsertCatalogueBook(candidate);
    const highlight = await addHighlight({
      bookId: candidate.id,
      locator: JSON.stringify({ sectionId: 's1', para: 2, start: 0, end: 10 }),
      quote: 'It is a truth universally acknowledged',
      note: 'Famous opening',
    });
    expect(await listHighlights(candidate.id)).toHaveLength(1);
    await updateHighlightNote(highlight.id, 'Updated note');
    const withBooks = await listHighlightsWithBooks();
    expect(withBooks[0].note).toBe('Updated note');
    expect(withBooks[0].bookTitle).toBe('Pride and Prejudice');
    await deleteHighlight(highlight.id);
    expect(await listHighlights()).toHaveLength(0);
  });

  it('schedules cards and records an immutable review', async () => {
    await upsertCatalogueBook(candidate);
    const now = Date.now();
    const created = await addCards(candidate.id, [
      { front: 'What is compound interest?', back: 'Interest on interest.' },
    ]);
    expect(created).toBe(1);
    const due = await dueCards(now + 1);
    expect(due).toHaveLength(1);
    const { card, review } = await reviewCard(due[0].id, 3, now);
    expect(review.rating).toBe(3);
    expect(card.reps).toBe(1);
    expect(card.state).toBe('review');
    expect(card.dueAt).toBeGreaterThan(now);
    const reviews = await driver.all('SELECT * FROM reviews');
    expect(reviews).toHaveLength(1);
  });

  it('links summaries to their source chunks', async () => {
    await upsertCatalogueBook(candidate);
    const summary = await saveSummary({
      bookId: candidate.id,
      kind: 'summary',
      title: 'Summary',
      bodyMd: 'A short summary.',
      provider: 'extractive',
      sourceChunkIds: ['c1', 'c2'],
    });
    expect(await listSummaries(candidate.id)).toHaveLength(1);
    expect(await summarySourceChunks(summary.id)).toEqual(['c1', 'c2']);
  });

  it('persists conversations in order', async () => {
    await upsertCatalogueBook(candidate);
    const conversation = await createConversation(candidate.id, 'First question');
    await addMessage(conversation.id, 'user', 'What happens?');
    await addMessage(conversation.id, 'assistant', 'This happens.', [
      { chunkId: 'c1', bookId: candidate.id, quote: 'evidence' },
    ]);
    const messages = await listMessages(conversation.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].citations?.[0].chunkId).toBe('c1');
  });

  it('deletes all user data but keeps the schema', async () => {
    await upsertCatalogueBook(candidate);
    await addHighlight({ bookId: candidate.id, locator: '{}', quote: 'x' });
    await deleteAllUserData();
    expect(await listLibrary()).toHaveLength(0);
    expect(await listHighlights()).toHaveLength(0);
    const tables = await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    expect(tables.map((t) => t.name)).toContain('books');
  });

  it('rejects a database newer than the binary', async () => {
    await driver.exec('PRAGMA user_version = 99');
    await expect(migrate(driver)).rejects.toThrow(/newer/);
  });
});
