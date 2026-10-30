/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import type { Chunk, Section } from '@/domain/types';
import { summariseBookDeep, type SummaryCheckpoint } from '@/features/learning/summarise';

const BOOK_ID = 'b1';
const DOCUMENT_ID = 'doc1';

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  calls: AiRequest[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (request.task === 'notes') {
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

class RecordingCheckpoint implements SummaryCheckpoint {
  readonly store = new Map<string, unknown>();
  saves: { stage: string; ordinal: number }[] = [];
  failures: string[] = [];
  cancelAfterSaves: number | null = null;
  failSaveFor: string | null = null;

  private key(stage: string, ordinal: number): string {
    return `${stage}:${ordinal}`;
  }

  async load(stage: 'map' | 'merge' | 'reduce' | 'expand', ordinal: number) {
    return this.store.get(this.key(stage, ordinal)) ?? null;
  }

  async begin() {
    /* begin is a no-op in this fake */
  }

  async save(
    stage: 'map' | 'merge' | 'reduce' | 'expand',
    ordinal: number,
    _key: string,
    result: unknown,
  ): Promise<void> {
    if (this.failSaveFor === stage) throw new Error('checkpoint write failed');
    this.store.set(this.key(stage, ordinal), result);
    this.saves.push({ stage, ordinal });
  }

  async fail(stage: 'map' | 'merge' | 'reduce' | 'expand') {
    this.failures.push(stage);
  }

  cancelled(): boolean {
    return this.cancelAfterSaves !== null && this.saves.length >= this.cancelAfterSaves;
  }
}

async function seedBook(count = 40): Promise<void> {
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
  const chunks: Chunk[] = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    documentId: DOCUMENT_ID,
    sectionId: 's1',
    ordinal: index,
    text: `Passage ${index} describes compound interest and steady deliberate practice.`,
    page: 1,
    charStart: null,
    charEnd: null,
  }));
  const section: Section = {
    id: 's1',
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
}

describe('summariseBookDeep checkpoints', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await seedBook();
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('reuses a stored map result without calling the provider for that window', async () => {
    const first = new FakeProvider();
    const recorder = new RecordingCheckpoint();
    const baseline = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider: first,
      persist: false,
      checkpoint: recorder,
    });
    const mapCalls = first.calls.filter((call) => call.task === 'notes').length;
    expect(recorder.store.has('map:0')).toBe(true);

    const second = new FakeProvider();
    const replay = new RecordingCheckpoint();
    replay.store.set('map:0', recorder.store.get('map:0'));
    const resumed = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider: second,
      persist: false,
      checkpoint: replay,
    });

    const replayedCalls = second.calls.filter((call) => call.task === 'notes').length;
    expect(replayedCalls).toBe(mapCalls - 1);
    expect(resumed.text).toBe(baseline.text);
    expect(resumed.sourceChunkIds).toEqual(baseline.sourceChunkIds);
  });

  it('propagates a checkpoint save failure instead of swallowing it', async () => {
    const checkpoint = new RecordingCheckpoint();
    checkpoint.failSaveFor = 'map';
    await expect(
      summariseBookDeep({
        bookId: BOOK_ID,
        kind: 'summary',
        targetWords: 700,
        provider: new FakeProvider(),
        persist: false,
        checkpoint,
      }),
    ).rejects.toThrow('checkpoint write failed');
  });

  it('stops with cancellation after a completed unit', async () => {
    const checkpoint = new RecordingCheckpoint();
    checkpoint.cancelAfterSaves = 1;
    await expect(
      summariseBookDeep({
        bookId: BOOK_ID,
        kind: 'summary',
        targetWords: 700,
        provider: new FakeProvider(),
        persist: false,
        checkpoint,
      }),
    ).rejects.toThrow(/^cancelled$/);
    expect(checkpoint.saves.filter((save) => save.stage === 'reduce')).toHaveLength(0);
    expect(checkpoint.saves.filter((save) => save.stage === 'expand')).toHaveLength(0);
  });
});
