/** @jest-environment node */
import { extractiveProvider } from '@/ai/extractive';
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { listSummaries, summarySourceChunks } from '@/data/repositories/learning';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import { wordCount } from '@/domain/text';
import type { Chunk, Section } from '@/domain/types';
import { summariseBook } from '@/features/learning/generate';
import {
  lengthToWords,
  planParts,
  planWindows,
  summariseBookDeep,
  trimToWords,
  withinTolerance,
  wordsForMinutes,
} from '@/features/learning/summarise';

const mockProviderRef: { current: AiProvider | null } = { current: null };

jest.mock('@/ai', () => ({
  resolveProvider: jest.fn(async () => {
    if (!mockProviderRef.current) throw new Error('No fake provider configured.');
    return mockProviderRef.current;
  }),
}));

const BOOK_ID = 'b1';
const DOCUMENT_ID = 'doc1';
const SECTION_ID = 's1';

function chunkText(index: number): string {
  return [
    `Passage ${index} describes compound interest and how reinvested interest grows the principal over time.`,
    'It explains that spaced repetition strengthens long-term memory when review intervals increase gradually.',
    'The argument connects steady deliberate practice with durable understanding and measurable progress.',
  ].join(' ');
}

function makeChunks(count: number): Chunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    documentId: DOCUMENT_ID,
    sectionId: SECTION_ID,
    ordinal: index,
    text: chunkText(index),
    page: Math.floor(index / 5) + 1,
    charStart: null,
    charEnd: null,
  }));
}

async function seedBook(count = 40): Promise<Chunk[]> {
  await upsertCatalogueBook({
    id: BOOK_ID,
    provider: 'gutendex',
    title: 'Compound Interest',
    author: 'Ada Example',
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
  const chunks = makeChunks(count);
  const section: Section = {
    id: SECTION_ID,
    documentId: DOCUMENT_ID,
    ordinal: 0,
    title: 'Chapter One',
    href: null,
    startPage: 1,
    endPage: 10,
    charStart: null,
    charEnd: null,
    text: null,
  };
  await replaceExtraction(DOCUMENT_ID, [section], chunks);
  return chunks;
}

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  calls: AiRequest[] = [];

  constructor(private readonly failMaps = false) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (request.task === 'notes') {
      const mapIndex = this.calls.filter((call) => call.task === 'notes').length - 1;
      if (this.failMaps && mapIndex % 5 < 2) throw new Error('map call failed');
      return {
        text: request.sources
          .map((source) => `[${source.chunkId}] ${source.text.slice(0, 80)}`)
          .join('\n'),
        citations: [],
        provider: this.id,
      };
    }
    if (request.task === 'outline') {
      return {
        text: ['## Part 1', '- one', '## Part 2', '- two', '## Part 3', '- three'].join('\n'),
        citations: [],
        provider: this.id,
      };
    }
    if (request.task === 'script') {
      const target = Math.max(1, Math.round(request.targetWords ?? 100));
      return {
        text: Array.from({ length: target }, () => 'insight').join(' '),
        citations: [],
        provider: this.id,
      };
    }
    return { text: 'canned text', citations: [], provider: this.id };
  }
}

describe('summarise planning functions', () => {
  it('keeps the whole book in at most 18 windows', () => {
    const chunks = Array.from({ length: 5_000 }, (_, index) => ({
      id: `c${index}`,
      text: `Sentence ${index} explains compound interest and steady deliberate practice.`,
    }));
    const windows = planWindows(chunks);
    expect(windows.length).toBeLessThanOrEqual(18);
    const ids = windows.flatMap((window) => window.chunkIds);
    expect(new Set(ids)).toEqual(new Set(chunks.map((chunk) => chunk.id)));
    // Order is preserved: the first occurrence of each id follows source order.
    expect(ids.filter((id, index) => ids.indexOf(id) === index)).toEqual(
      chunks.map((chunk) => chunk.id),
    );
    const original = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    const covered = windows.reduce((sum, window) => sum + window.text.length, 0);
    expect(covered).toBeGreaterThanOrEqual(original * 0.95);
  });

  it('reduces a one-chunk book to a single window', () => {
    const windows = planWindows([{ id: 'only', text: 'One short passage.' }]);
    expect(windows).toHaveLength(1);
    expect(windows[0].chunkIds).toEqual(['only']);
  });

  it('distributes a word budget exactly across 3-5 parts', () => {
    const parts = planParts([{ heading: 'A' }, { heading: 'B' }], 2_175);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.length).toBeLessThanOrEqual(5);
    expect(parts.reduce((sum, part) => sum + part.words, 0)).toBe(2_175);
    expect(parts[0].heading).toBe('A');
    expect(parts[1].heading).toBe('B');
    expect(parts[2].heading).toBe('Part 3');
  });

  it('trims at a sentence boundary without exceeding the budget', () => {
    const text =
      'First sentence has five words here. Second sentence is a little longer than the first one. Third one follows.';
    const trimmed = trimToWords(text, 12);
    expect(wordCount(trimmed)).toBeLessThanOrEqual(12);
    expect(trimmed.endsWith('.')).toBe(true);
    expect(trimToWords('One two three.', 10)).toBe('One two three.');
  });

  it('exposes the spoken word budgets', () => {
    expect(wordsForMinutes(5)).toBe(725);
    expect(wordsForMinutes(15)).toBe(2_175);
    expect(wordsForMinutes(25)).toBe(3_625);
    expect(lengthToWords('short')).toBe(250);
    expect(lengthToWords('medium')).toBe(700);
    expect(lengthToWords('long')).toBe(1_400);
  });
});

describe('summariseBookDeep', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
  });

  afterEach(async () => {
    mockProviderRef.current = null;
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('runs the map-reduce pipeline and writes source rows for the whole book', async () => {
    const chunks = await seedBook(40);
    const provider = new FakeProvider();
    const output = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider,
    });

    expect(output.summaryId).toBeTruthy();
    expect(output.calls).toBeLessThanOrEqual(28);
    expect(output.degraded).toBe(false);
    expect(withinTolerance(output.words, 700)).toBe(true);
    expect(output.text.length).toBeGreaterThan(0);

    const rows = await summarySourceChunks(output.summaryId as string);
    expect(new Set(rows)).toEqual(new Set(chunks.map((chunk) => chunk.id)));
    expect(new Set(output.sourceChunkIds)).toEqual(new Set(chunks.map((chunk) => chunk.id)));
  });

  it('writes nothing when persist is false but still returns text', async () => {
    await seedBook(40);
    const output = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider: new FakeProvider(),
      persist: false,
    });
    expect(output.summaryId).toBeNull();
    expect(output.text.length).toBeGreaterThan(0);
    expect(await listSummaries(BOOK_ID)).toHaveLength(0);
  });

  it('degrades to extractive when 40% of map calls fail, and still persists a summary', async () => {
    await seedBook(40);
    const output = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider: new FakeProvider(true),
    });
    expect(output.degraded).toBe(true);
    expect(output.provider).toBe('extractive');
    expect(output.summaryId).toBeTruthy();
    expect(withinTolerance(output.words, 700)).toBe(true);
    expect(await listSummaries(BOOK_ID)).toHaveLength(1);
  });

  it('throws before saving when the signal is already aborted', async () => {
    await seedBook(40);
    const controller = new AbortController();
    controller.abort();
    await expect(
      summariseBookDeep({
        bookId: BOOK_ID,
        kind: 'summary',
        targetWords: 700,
        provider: new FakeProvider(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(await listSummaries(BOOK_ID)).toHaveLength(0);
  });

  it('drives the same pipeline with the extractive provider', async () => {
    await seedBook(40);
    const output = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider: extractiveProvider,
    });
    expect(output.provider).toBe('extractive');
    expect(output.degraded).toBe(true);
    expect(output.summaryId).toBeTruthy();
    expect(withinTolerance(output.words, 700)).toBe(true);
  });

  it('reports per-call progress and fires the save stage once', async () => {
    await seedBook(40);
    const stages: string[] = [];
    await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider: new FakeProvider(),
      onProgress: (event) => {
        stages.push(event.stage);
      },
    });
    expect(stages.filter((stage) => stage === 'save')).toHaveLength(1);
    expect(stages).toContain('map');
    expect(stages).toContain('reduce');
    expect(stages).toContain('expand');
  });
});

describe('summariseBook integration', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
  });

  afterEach(async () => {
    mockProviderRef.current = null;
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('covers all 40 chunks instead of sampling 12', async () => {
    const chunks = await seedBook(40);
    const provider = new FakeProvider();
    mockProviderRef.current = provider;
    const result = await summariseBook(BOOK_ID, 'summary', 'medium');

    expect(result.summaryId).toBeTruthy();
    const mapCalls = provider.calls.filter((call) => call.task === 'notes');
    expect(mapCalls.length).toBeGreaterThanOrEqual(2);
    const seen = new Set(
      mapCalls.flatMap((call) => call.sources.map((source) => source.chunkId)),
    );
    for (const chunk of chunks) expect(seen.has(chunk.id)).toBe(true);
    expect(await listSummaries(BOOK_ID)).toHaveLength(1);
  });
});
