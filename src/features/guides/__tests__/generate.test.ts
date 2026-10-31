/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import {
  getGuide,
  getGuideChapter,
  getOrCreateGuide,
  listGuideChapterSegments,
  replaceGuideChapters,
} from '@/data/repositories/guides';
import { wordCount } from '@/domain/text';
import type { Chunk, Section } from '@/domain/types';
import { setForegroundBridgeForTests } from '@/features/jobs/foreground';
import type { NarrationEngine } from '@/features/narration/engines';
import { GUIDE_CHAPTER_MAX_WORDS } from '@/features/guides/constants';
import {
  cancelGuideGeneration,
  generateGuideChapter,
  startGuideGeneration,
} from '@/features/guides/generate';

const BOOK_ID = 'b1';
const DOCUMENT_ID = 'doc1';

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  calls: AiRequest[] = [];

  constructor(
    private readonly scriptFactor = 1,
    private readonly degraded = false,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (request.task === 'notes') {
      return {
        text: request.sources
          .map((source) => `[${source.chunkId}] ${source.text.slice(0, 120)}`)
          .join('\n'),
        citations: [],
        provider: this.id,
        degraded: this.degraded,
      };
    }
    if (request.task === 'outline') {
      return {
        text: ['## Part 1', '- one', '## Part 2', '- two', '## Part 3', '- three'].join('\n'),
        citations: [],
        provider: this.id,
        degraded: this.degraded,
      };
    }
    if (request.task === 'script') {
      const target = Math.max(1, Math.round((request.targetWords ?? 100) * this.scriptFactor));
      return {
        text: Array.from({ length: target }, () => 'word').join(' '),
        citations: [],
        provider: this.id,
        degraded: this.degraded,
      };
    }
    return { text: 'Answer.', citations: [], provider: this.id, degraded: this.degraded };
  }
}

class ThrowingProvider implements AiProvider {
  readonly id = 'throwing';
  readonly label = 'Throwing';
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async generate(): Promise<AiResponse> {
    throw new Error('provider should not be called');
  }
}

class FakeEngine implements NarrationEngine {
  readonly producesFiles = true;
  calls = 0;

  constructor(
    readonly id: NarrationEngine['id'] = 'remote',
    private readonly failOnCall: number | null = null,
  ) {}

  get label() {
    return `Fake ${this.id}`;
  }

  async probe() {
    return { available: true as const };
  }

  async synthesize(request: Parameters<NarrationEngine['synthesize']>[0]) {
    this.calls += 1;
    if (this.failOnCall === this.calls) throw new Error('synthesis failed');
    return {
      uri: `memory://${request.text.length}`,
      bytes: request.text.length,
      cached: false,
      format: request.format,
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

function longText(label: string): string {
  return Array.from(
    { length: 12 },
    (_, index) =>
      `${label} passage ${index} explains how steady saving and patient compounding reward ordinary decisions made over a long lifetime.`,
  ).join(' ');
}

async function seedBook(): Promise<void> {
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
  const sections: Section[] = [
    {
      id: 's1',
      documentId: DOCUMENT_ID,
      ordinal: 0,
      title: 'One',
      href: null,
      startPage: 1,
      endPage: 10,
      charStart: null,
      charEnd: null,
      text: null,
    },
    {
      id: 's2',
      documentId: DOCUMENT_ID,
      ordinal: 1,
      title: 'Two',
      href: null,
      startPage: 11,
      endPage: 20,
      charStart: null,
      charEnd: null,
      text: null,
    },
  ];
  const chunks: Chunk[] = [
    {
      id: 'c1',
      documentId: DOCUMENT_ID,
      sectionId: 's1',
      ordinal: 0,
      text: longText('First'),
      page: 1,
      charStart: null,
      charEnd: null,
    },
    {
      id: 'c2',
      documentId: DOCUMENT_ID,
      sectionId: 's2',
      ordinal: 1,
      text: longText('Second'),
      page: 11,
      charStart: null,
      charEnd: null,
    },
  ];
  await replaceExtraction(DOCUMENT_ID, sections, chunks);
}

async function makeGuide(count = 2) {
  const guide = await getOrCreateGuide({
    bookId: BOOK_ID,
    title: 'The Psychology of Money',
    styleId: 'fireside',
    language: 'en',
    engine: 'device',
    voice: null,
    model: null,
  });
  const chapters = await replaceGuideChapters(
    guide.id,
    Array.from({ length: count }, (_, index) => ({
      title: `Chapter ${index + 1}`,
      startPage: index * 10 + 1,
      endPage: index * 10 + 10,
      sectionIds: [`s${index + 1}`],
    })),
  );
  return { guide: (await getGuide(guide.id))!, chapters };
}

function installForeground() {
  const start = jest.fn(async (_input: { title: string; text: string }) => {});
  const update = jest.fn(async (_input: { text: string; progress: number }) => {});
  const stop = jest.fn(async () => {});
  setForegroundBridgeForTests({ start, update, stop });
  return { start, update, stop };
}

describe('guide generation', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await seedBook();
  });

  afterEach(async () => {
    setForegroundBridgeForTests(null);
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('marks one chapter ready and keeps going when another chapter audio fails', async () => {
    const { guide, chapters } = await makeGuide(2);
    const provider = new FakeProvider(1);
    const engine = new FakeEngine('remote', 4);

    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine,
      provider,
    });

    expect(result).toEqual({
      completed: 1,
      failed: 1,
      cancelled: false,
      alreadyRunning: false,
    });

    const first = (await getGuideChapter(chapters[0].id))!;
    const second = (await getGuideChapter(chapters[1].id))!;
    expect(first.status).toBe('ready');
    expect(first.summaryMd).toBeTruthy();
    expect(first.wordCount).toBeGreaterThanOrEqual(212);
    expect(first.wordCount).toBeLessThanOrEqual(287);
    expect((await listGuideChapterSegments(first.id)).every((seg) => seg.status === 'ready')).toBe(
      true,
    );

    expect(second.status).toBe('failed');
    expect(second.summaryMd).toBeTruthy();
    expect(second.error).toContain('audio:');
    expect((await listGuideChapterSegments(second.id)).some((seg) => seg.status === 'failed')).toBe(
      true,
    );

    expect((await getGuide(guide.id))?.status).toBe('partial');
  });

  it('skips a ready chapter on the next run and retries the failed one from its stored summary', async () => {
    const { guide, chapters } = await makeGuide(2);
    await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine: new FakeEngine('remote', 4),
      provider: new FakeProvider(1),
    });

    const firstBefore = (await getGuideChapter(chapters[0].id))!;
    const firstSegmentsBefore = await listGuideChapterSegments(chapters[0].id);

    const retryEngine = new FakeEngine('remote');
    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine: retryEngine,
      provider: new ThrowingProvider(),
    });

    expect(result).toEqual({
      completed: 2,
      failed: 0,
      cancelled: false,
      alreadyRunning: false,
    });
    expect(retryEngine.calls).toBe(1);

    const firstAfter = (await getGuideChapter(chapters[0].id))!;
    expect(firstAfter.summaryMd).toBe(firstBefore.summaryMd);
    expect(firstAfter.status).toBe('ready');
    expect(await listGuideChapterSegments(chapters[0].id)).toEqual(firstSegmentsBefore);

    expect((await getGuideChapter(chapters[1].id))?.status).toBe('ready');
    expect((await getGuide(guide.id))?.status).toBe('generated');
  });

  it('does not start a second run while one is active', async () => {
    const { guide } = await makeGuide(1);
    const foreground = installForeground();
    const first = startGuideGeneration({
      guideId: guide.id,
      mode: 'script',
      engine: deviceEngine,
      provider: new FakeProvider(1),
    });
    const second = await startGuideGeneration({
      guideId: guide.id,
      mode: 'script',
      engine: deviceEngine,
      provider: new FakeProvider(1),
    });
    expect(second).toEqual({
      completed: 0,
      failed: 0,
      cancelled: false,
      alreadyRunning: true,
    });
    await first;
    expect(foreground.start).toHaveBeenCalledTimes(1);
  });

  it('drives one foreground lifecycle, updating after every chapter', async () => {
    const { guide } = await makeGuide(2);
    const foreground = installForeground();

    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'script',
      engine: deviceEngine,
      provider: new FakeProvider(1),
    });

    expect(result).toEqual({
      completed: 2,
      failed: 0,
      cancelled: false,
      alreadyRunning: false,
    });
    expect(foreground.start).toHaveBeenCalledTimes(1);
    expect(foreground.start.mock.calls[0][0]).toEqual({
      title: 'Building full guide',
      text: '0 of 2 chapters',
    });

    const updates = foreground.update.mock.calls.map(([input]) => input);
    expect(updates).toHaveLength(2);
    expect(updates.map((input) => input.text)).toEqual([
      'Chapter 1 of 2 · Chapter 1',
      'Chapter 2 of 2 · Chapter 2',
    ]);
    expect(updates.every((input) => input.progress >= 0 && input.progress <= 100)).toBe(true);
    expect(updates[updates.length - 1].progress).toBe(100);

    expect(foreground.stop).toHaveBeenCalledTimes(1);
    const updateOrders = foreground.update.mock.invocationCallOrder;
    expect(foreground.stop.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateOrders[updateOrders.length - 1],
    );
  });

  it('stops the foreground service when the run is cancelled', async () => {
    const { guide } = await makeGuide(2);
    const foreground = installForeground();
    const controller = new AbortController();

    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'script',
      engine: deviceEngine,
      provider: new FakeProvider(1),
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done === 1) controller.abort();
      },
    });

    expect(result.cancelled).toBe(true);
    expect(foreground.start).toHaveBeenCalledTimes(1);
    expect(foreground.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the foreground service when the run throws', async () => {
    const { guide } = await makeGuide(1);
    const foreground = installForeground();

    await expect(
      startGuideGeneration({
        guideId: guide.id,
        mode: 'script',
        engine: deviceEngine,
        provider: new FakeProvider(1),
        onProgress: () => {
          throw new Error('progress exploded');
        },
      }),
    ).rejects.toThrow('progress exploded');

    expect(foreground.start).toHaveBeenCalledTimes(1);
    expect(foreground.stop).toHaveBeenCalledTimes(1);
  });

  it('trims a 300-word chapter to the 287-word ceiling', async () => {
    const { guide, chapters } = await makeGuide(1);
    await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine: deviceEngine,
      provider: new FakeProvider(1.2),
    });

    const chapter = (await getGuideChapter(chapters[0].id))!;
    expect(chapter.status).toBe('ready');
    expect(chapter.wordCount).toBeLessThanOrEqual(GUIDE_CHAPTER_MAX_WORDS);
    expect(wordCount(chapter.summaryMd ?? '')).toBeLessThanOrEqual(GUIDE_CHAPTER_MAX_WORDS);
    expect((await getGuide(guide.id))?.status).toBe('generated');
  });

  it('retries a short chapter once and keeps it usable with word_budget', async () => {
    const { guide, chapters } = await makeGuide(1);
    const provider = new FakeProvider(0.8);
    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'script',
      engine: deviceEngine,
      provider,
    });

    expect(result).toEqual({
      completed: 1,
      failed: 0,
      cancelled: false,
      alreadyRunning: false,
    });
    const chapter = (await getGuideChapter(chapters[0].id))!;
    expect(chapter.status).toBe('scripted');
    expect(chapter.error).toBe('word_budget');
    expect(chapter.wordCount).toBeLessThan(212);
    const scriptCalls = provider.calls.filter((call) => call.task === 'script').length;
    expect(scriptCalls).toBe(6);
  });

  it('marks the stored provider when the summariser degrades', async () => {
    const { guide, chapters } = await makeGuide(1);
    await startGuideGeneration({
      guideId: guide.id,
      mode: 'script',
      engine: deviceEngine,
      provider: new FakeProvider(1, true),
    });

    const chapter = (await getGuideChapter(chapters[0].id))!;
    expect(chapter.provider).toBe('fake+extract');
    expect(chapter.summaryMd).toBeTruthy();
  });

  it('cancels between chapters, keeps the finished chapter and stops', async () => {
    const { guide, chapters } = await makeGuide(2);
    const controller = new AbortController();

    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine: deviceEngine,
      provider: new FakeProvider(1),
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done === 1) controller.abort();
      },
    });

    expect(result).toEqual({
      completed: 1,
      failed: 0,
      cancelled: true,
      alreadyRunning: false,
    });
    expect((await getGuideChapter(chapters[0].id))?.status).toBe('ready');
    expect((await getGuideChapter(chapters[1].id))?.status).toBe('pending');
    const stored = (await getGuide(guide.id))!;
    expect(stored.status).toBe('partial');
    expect(stored.error).toBe('cancelled');
  });

  it('leaves a chapter retryable when cancelled mid-synthesis', async () => {
    const { guide, chapters } = await makeGuide(1);
    const engine = new FakeEngine('kokoro');
    const original = engine.synthesize.bind(engine);
    engine.synthesize = async (request) => {
      const asset = await original(request);
      if (engine.calls === 2) await cancelGuideGeneration(guide.id);
      return asset;
    };

    const result = await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine,
      provider: new FakeProvider(1),
    });

    expect(result.cancelled).toBe(true);
    const cancelled = (await getGuideChapter(chapters[0].id))!;
    const segments = await listGuideChapterSegments(cancelled.id);
    expect(segments.filter((segment) => segment.status === 'ready').length).toBeGreaterThan(0);
    expect(segments.some((segment) => segment.status === 'queued')).toBe(true);
    // A cancelled chapter is not playable; it must stay retryable so a resume
    // finishes the queued segments instead of skipping the chapter.
    expect(cancelled.status).toBe('failed');
    expect(cancelled.error).toBe('cancelled');

    const resumed = await startGuideGeneration({
      guideId: guide.id,
      mode: 'all',
      engine: new FakeEngine('kokoro'),
      provider: new FakeProvider(1),
    });
    expect(resumed.failed).toBe(0);
    const finished = (await getGuideChapter(chapters[0].id))!;
    expect(finished.status).toBe('ready');
    expect(
      (await listGuideChapterSegments(finished.id)).every((segment) => segment.status === 'ready'),
    ).toBe(true);
  });

  it('fails a chapter cleanly when it has no sections', async () => {
    const { chapters } = await makeGuide(1);
    await driver.run("UPDATE guide_chapters SET section_ids_json = '[]' WHERE id = ?", [
      chapters[0].id,
    ]);
    await expect(
      generateGuideChapter({
        guideId: chapters[0].guideId,
        chapterId: chapters[0].id,
        mode: 'script',
        engine: deviceEngine,
        provider: new FakeProvider(1),
      }),
    ).rejects.toThrow('no_sections');
    expect((await getGuideChapter(chapters[0].id))?.error).toBe('no_sections');
  });
});
