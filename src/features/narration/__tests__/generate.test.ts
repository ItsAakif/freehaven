/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import {
  getOrCreateRendition,
  getRendition,
  listSegments,
  setRenditionEngine,
} from '@/data/repositories/renditions';
import type { Chunk, Section } from '@/domain/types';
import type { NarrationEngine } from '@/features/narration/engines';
import { createScript, synthesiseRendition } from '@/features/narration/generate';

const providerRef: { current: AiProvider | null } = { current: null };

jest.mock('@/ai', () => ({
  resolveProvider: jest.fn(async () => {
    if (!providerRef.current) throw new Error('No fake provider configured.');
    return providerRef.current;
  }),
}));

const BOOK_ID = 'b1';
const DOCUMENT_ID = 'doc1';
const SECTION_ID = 's1';

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls += 1;
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
      const words = Math.max(1, request.targetWords ?? 100);
      return {
        text: Array.from({ length: words }, () => 'word').join(' '),
        citations: [],
        provider: this.id,
      };
    }
    return { text: 'Answer.', citations: [], provider: this.id };
  }
}

class FakeEngine implements NarrationEngine {
  readonly producesFiles = true;
  calls = 0;
  failOnCall: number | null = null;
  abortedSignal: AbortSignal | null = null;
  timings?: { text: string; startMs: number; endMs: number }[];

  constructor(readonly id: NarrationEngine['id'] = 'remote') {}

  get label() {
    return `Fake ${this.id}`;
  }

  async probe() {
    return { available: true as const };
  }

  async synthesize(request: Parameters<NarrationEngine['synthesize']>[0]) {
    this.calls += 1;
    if (this.abortedSignal?.aborted) {
      throw new Error('aborted');
    }
    if (this.failOnCall === this.calls) throw new Error('synthesis failed');
    if (this.abortedSignal) this.abortedSignal.dispatchEvent?.(new Event('abort'));
    return {
      uri: `memory://${request.destPath ?? request.text.length}`,
      bytes: request.text.length,
      cached: false,
      format: request.format,
      ...(this.timings ? { timings: this.timings } : {}),
    };
  }
}

const deviceEngine: NarrationEngine = {
  id: 'device',
  label: 'Device',
  producesFiles: false,
  async probe() {
    return { available: true };
  },
  async synthesize() {
    throw new Error('device does not synthesize');
  },
};

function makeChunks(count: number): Chunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    documentId: DOCUMENT_ID,
    sectionId: SECTION_ID,
    ordinal: index,
    text: `Passage ${index} explains compound interest and how reinvested interest grows the principal over time. Spaced repetition strengthens long-term memory when review intervals increase gradually.`,
    page: Math.floor(index / 5) + 1,
    charStart: null,
    charEnd: null,
  }));
}

async function seedBook(count = 12): Promise<void> {
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
  await replaceExtraction(DOCUMENT_ID, [section], makeChunks(count));
}

describe('narration generation', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await seedBook();
    providerRef.current = new FakeProvider();
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('writes a script within the length budget and plans ordered segments', async () => {
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'fireside',
      length: '5',
    });
    const result = await createScript({ renditionId: rendition.id });
    expect(result.words).toBeGreaterThanOrEqual(725 * 0.85);
    expect(result.words).toBeLessThanOrEqual(725 * 1.15);

    const stored = await getRendition(rendition.id);
    expect(stored?.status).toBe('script_ready');
    expect(stored?.scriptMd).toBeTruthy();
    expect(stored?.wordCount).toBe(result.words);

    const segments = await listSegments(rendition.id);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.map((segment) => segment.ordinal)).toEqual(
      segments.map((_, index) => index),
    );
    expect(segments.every((segment) => segment.text.length > 0)).toBe(true);
    expect(segments.every((segment) => !!segment.speechKey)).toBe(true);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].sectionOrdinal ?? 0).toBeGreaterThanOrEqual(
        segments[index - 1].sectionOrdinal ?? 0,
      );
    }
  });

  it('marks device-engine segments ready without files', async () => {
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'brief',
      length: '5',
    });
    await createScript({ renditionId: rendition.id });
    const result = await synthesiseRendition({ renditionId: rendition.id, engine: deviceEngine });
    const segments = await listSegments(rendition.id);
    expect(result.failed).toBe(0);
    expect(result.done).toBe(segments.length);
    expect(segments.every((segment) => segment.status === 'ready')).toBe(true);
    expect(segments.every((segment) => segment.filePath === null)).toBe(true);
    expect((await getRendition(rendition.id))?.status).toBe('ready');
  });

  it('skips ready segments on a second synthesis and computes offsets', async () => {
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'chronicle',
      length: '15',
    });
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'nova',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
    await createScript({ renditionId: rendition.id });

    const engine = new FakeEngine('remote');
    const first = await synthesiseRendition({ renditionId: rendition.id, engine });
    const callsAfterFirst = engine.calls;
    const second = await synthesiseRendition({ renditionId: rendition.id, engine });
    expect(second.done).toBe(first.done);
    expect(engine.calls).toBe(callsAfterFirst);

    const segments = await listSegments(rendition.id);
    expect(segments.every((segment) => segment.status === 'ready')).toBe(true);
    const firstStart = segments[0].startMs;
    expect(firstStart).toBe(0);
    for (let index = 1; index < segments.length; index += 1) {
      const previous = segments[index - 1];
      const expected = previous.startMs + (previous.durationMs ?? 0);
      expect(segments[index].startMs).toBe(expected);
    }
    expect((await getRendition(rendition.id))?.durationMs).toBeGreaterThan(0);
  });

  it('persists engine word timings as segment json', async () => {
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'brief',
      length: '5',
    });
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'onyx',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
    await createScript({ renditionId: rendition.id });

    const engine = new FakeEngine('remote');
    engine.timings = [
      { text: 'first', startMs: 0, endMs: 250 },
      { text: 'second', startMs: 300, endMs: 700 },
    ];
    await synthesiseRendition({ renditionId: rendition.id, engine });

    const segments = await listSegments(rendition.id);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(JSON.parse(segment.timingsJson ?? 'null')).toEqual(engine.timings);
    }
  });

  it('leaves earlier segments ready when synthesis fails mid-way', async () => {
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'mechanism',
      length: '25',
    });
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'echo',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
    await createScript({ renditionId: rendition.id });
    const planned = await listSegments(rendition.id);
    expect(planned.length).toBeGreaterThan(2);

    const engine = new FakeEngine('remote');
    engine.failOnCall = 3;
    const result = await synthesiseRendition({ renditionId: rendition.id, engine });
    expect(result.failed).toBe(1);
    expect(result.done).toBeGreaterThanOrEqual(2);

    const segments = await listSegments(rendition.id);
    expect(segments[0].status).toBe('ready');
    expect(segments[1].status).toBe('ready');
    expect(segments[2].status).toBe('failed');
    expect((await getRendition(rendition.id))?.status).toBe('failed');
  });

  it('can resume after a cancel without re-synthesising finished segments', async () => {
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'debate',
      length: '15',
    });
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'alloy',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
    await createScript({ renditionId: rendition.id });

    const controller = new AbortController();
    const engine = new FakeEngine('remote');
    const original = engine.synthesize.bind(engine);
    engine.synthesize = async (request) => {
      const asset = await original(request);
      controller.abort();
      return asset;
    };
    const cancelled = await synthesiseRendition({
      renditionId: rendition.id,
      engine,
      signal: controller.signal,
    });
    expect(cancelled.done).toBeGreaterThan(0);
    expect((await getRendition(rendition.id))?.status).toBe('failed');

    const before = (await listSegments(rendition.id)).filter((s) => s.status === 'ready').length;
    const resumed = await synthesiseRendition({
      renditionId: rendition.id,
      engine: new FakeEngine('remote'),
    });
    expect(resumed.done).toBeGreaterThanOrEqual(before);
    expect((await getRendition(rendition.id))?.status).toBe('ready');
  });
});
