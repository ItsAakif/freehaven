/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import type { Chunk, Section } from '@/domain/types';
import { askBook, coverageChunks, wholeBookIntent } from '@/features/learning/generate';

const providerRef: { current: AiProvider | null } = { current: null };

jest.mock('@/ai', () => ({
  resolveProvider: jest.fn(async () => {
    if (!providerRef.current) throw new Error('No fake provider configured.');
    return providerRef.current;
  }),
}));

const BOOK_ID = 'b1';
const DOCUMENT_ID = 'doc1';
const CHUNK_COUNT = 60;
const RISK_ORDINAL = 17;

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  calls: AiRequest[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    return { text: 'canned answer', citations: [], provider: this.id };
  }
}

function makeChunks(): Chunk[] {
  return Array.from({ length: CHUNK_COUNT }, (_, index) => ({
    id: `chk_${index}`,
    documentId: DOCUMENT_ID,
    sectionId: `sec_${Math.floor(index / 10)}`,
    ordinal: index,
    text:
      index === RISK_ORDINAL
        ? 'Risk is the probability of loss in every investment decision, and this book treats it carefully.'
        : `Passage ${index} explains compounding, patience and steady habits across the years.`,
    page: index + 1,
    charStart: null,
    charEnd: null,
  }));
}

async function seedBook(): Promise<Chunk[]> {
  await upsertCatalogueBook({
    id: BOOK_ID,
    provider: 'gutendex',
    title: 'The Psychology of Money',
    author: 'Morgan Example',
    subjects: [],
    source: 'gutenberg',
    sourceId: '1',
    access: 'public_domain',
    license: 'Public domain',
  });
  await saveDocument({
    id: DOCUMENT_ID,
    bookId: BOOK_ID,
    format: 'text',
    status: 'ready',
    importedAt: Date.now(),
  });
  const chunks = makeChunks();
  const sections: Section[] = Array.from({ length: CHUNK_COUNT / 10 }, (_, index) => ({
    id: `sec_${index}`,
    documentId: DOCUMENT_ID,
    ordinal: index,
    title: `Chapter ${index + 1}`,
    href: null,
    startPage: index * 10 + 1,
    endPage: (index + 1) * 10,
    charStart: null,
    charEnd: null,
    text: null,
  }));
  await replaceExtraction(DOCUMENT_ID, sections, chunks);
  return chunks;
}

describe('wholeBookIntent', () => {
  it.each([
    'What is the main argument of this book?',
    'Summarize the book for me.',
    'What is this book about?',
    "What's the thesis?",
    'What is the overall message of the author?',
    'Give me the big idea.',
    'What are the key ideas of the book?',
    'Summarise the book chapter by chapter.',
  ])('treats %s as a whole-book question', (question) => {
    expect(wholeBookIntent(question)).toBe(true);
  });

  it.each([
    'What does the book say about risk?',
    'Give me a concrete example from the text.',
    'Who is the author?',
    'What is risk?',
    'What is the main argument of chapter 3?',
    'What is the main argument of this passage?',
    'Summarise chapter 4 of this book.',
  ])('does not treat %s as a whole-book question', (question) => {
    expect(wholeBookIntent(question)).toBe(false);
  });
});

describe('coverageChunks', () => {
  function plainChunks(count: number): Chunk[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `c${index}`,
      documentId: DOCUMENT_ID,
      sectionId: `s${index % 2}`,
      ordinal: index,
      text: `Passage ${index}.`,
      page: index + 1,
    }));
  }

  it('samples start, middle and end in book order without duplicates', () => {
    const picked = coverageChunks(plainChunks(12), 6);
    expect(picked.map((chunk) => chunk.id)).toEqual(['c0', 'c1', 'c4', 'c7', 'c8', 'c11']);
    expect(new Set(picked.map((chunk) => chunk.id)).size).toBe(6);
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i].ordinal).toBeGreaterThan(picked[i - 1].ordinal);
      expect(picked[i].sectionId).not.toBe(picked[i - 1].sectionId);
    }
  });

  it('returns every chunk in order when there are no more than the limit', () => {
    const chunks = plainChunks(4);
    expect(coverageChunks(chunks, 6).map((chunk) => chunk.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('deduplicates repeated ids', () => {
    const chunks = plainChunks(12);
    const picked = coverageChunks([...chunks, chunks[0]], 6);
    expect(picked.map((chunk) => chunk.id)).toEqual(['c0', 'c1', 'c4', 'c7', 'c8', 'c11']);
  });
});

describe('askBook retrieval path', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
  });

  afterEach(async () => {
    providerRef.current = null;
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('gives a whole-book question six spread chunks from across the book', async () => {
    const chunks = await seedBook();
    const provider = new FakeProvider();
    providerRef.current = provider;

    await askBook({ bookId: BOOK_ID, question: 'What is the main argument of this book?' });

    const request = provider.calls.at(-1)!;
    expect(request.task).toBe('answer');
    expect(request.sources).toHaveLength(6);
    expect(request.sources[0].chunkId).toBe('chk_0');
    expect(request.sources.at(-1)!.chunkId).toBe(`chk_${CHUNK_COUNT - 1}`);
    expect(new Set(request.sources.map((source) => source.chunkId)).size).toBe(6);
    // Every source is a real stored chunk.
    const realIds = new Set(chunks.map((chunk) => chunk.id));
    for (const source of request.sources) expect(realIds.has(source.chunkId)).toBe(true);
    expect(request.instruction).toContain('whole book');
    expect(request.instruction).toContain('beginning, middle and end');
  });

  it('still uses BM25 hits for a specific question', async () => {
    await seedBook();
    const provider = new FakeProvider();
    providerRef.current = provider;

    await askBook({ bookId: BOOK_ID, question: 'What does the book say about risk?' });

    const request = provider.calls.at(-1)!;
    expect(request.sources).toHaveLength(1);
    expect(request.sources[0].chunkId).toBe(`chk_${RISK_ORDINAL}`);
    expect(request.instruction).toBeUndefined();
  });

  it('falls back to spread coverage when BM25 finds no hits', async () => {
    await seedBook();
    const provider = new FakeProvider();
    providerRef.current = provider;

    await askBook({ bookId: BOOK_ID, question: 'zzzz qqqq' });

    const request = provider.calls.at(-1)!;
    expect(request.sources).toHaveLength(6);
    expect(request.sources[0].chunkId).toBe('chk_0');
    expect(request.sources.at(-1)!.chunkId).toBe(`chk_${CHUNK_COUNT - 1}`);
    expect(request.instruction).toContain('whole book');
  });
});
