/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import {
  getOrCreateRendition,
  getRendition,
  setRenditionEngine,
} from '@/data/repositories/renditions';
import type { Chunk, Section } from '@/domain/types';
import type { NarrationEngine } from '@/features/narration/engines';
import { startGeneration } from '@/features/jobs/runner';

const providerRef: { current: AiProvider | null } = { current: null };

jest.mock('@/ai', () => ({
  resolveProvider: jest.fn(async () => {
    if (!providerRef.current) throw new Error('No fake provider configured.');
    return providerRef.current;
  }),
}));

const BOOK_ID = 'b1';
const DOCUMENT_ID = 'doc1';

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  calls: AiRequest[] = [];
  abortAfterNotes: number | null = null;
  controller: AbortController | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (request.task === 'notes') {
      const callNumber = this.calls.filter((call) => call.task === 'notes').length;
      if (this.abortAfterNotes === callNumber) this.controller?.abort();
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
    return { text: 'canned', citations: [], provider: this.id };
  }
}

class FakeEngine implements NarrationEngine {
  readonly producesFiles = true;
  calls = 0;

  constructor(readonly id: NarrationEngine['id'] = 'remote') {}

  get label() {
    return `Fake ${this.id}`;
  }

  async probe() {
    return { available: true as const };
  }

  async synthesize(request: Parameters<NarrationEngine['synthesize']>[0]) {
    this.calls += 1;
    return {
      uri: `memory://${request.destPath ?? this.calls}`,
      bytes: request.text.length,
      cached: false,
      format: request.format,
    };
  }
}

async function seedBook(count = 120): Promise<void> {
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
    wordCount: 9_000,
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

describe('generation end to end', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await seedBook();
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

  it('produces identical script text after a forced kill and resume', async () => {
    // Uninterrupted reference.
    const referenceProvider = new FakeProvider();
    providerRef.current = referenceProvider;
    const reference = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'fireside',
      length: '15',
    });
    await setRenditionEngine(reference.id, {
      engine: 'remote',
      voice: 'alloy',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
    await startGeneration({
      renditionId: reference.id,
      mode: 'all',
      now: 1_000,
      engine: new FakeEngine('remote'),
    });
    const referenceScript = (await getRendition(reference.id))?.scriptMd;
    expect(referenceScript).toBeTruthy();

    // Same inputs, killed after two map units, then resumed.
    const killed = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'chronicle',
      length: '15',
    });
    await setRenditionEngine(killed.id, {
      engine: 'remote',
      voice: 'alloy',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });

    const controller = new AbortController();
    const killedProvider = new FakeProvider();
    killedProvider.controller = controller;
    killedProvider.abortAfterNotes = 2;
    providerRef.current = killedProvider;
    await startGeneration({
      renditionId: killed.id,
      mode: 'all',
      now: 2_000,
      signal: controller.signal,
      engine: new FakeEngine('remote'),
    });

    const resumeProvider = new FakeProvider();
    providerRef.current = resumeProvider;
    const resumed = await startGeneration({
      renditionId: killed.id,
      mode: 'all',
      now: 3_000,
      engine: new FakeEngine('remote'),
    });
    expect(resumed.kind).toBe('started');

    const resumedScript = (await getRendition(killed.id))?.scriptMd;
    expect(resumedScript).toBeTruthy();
    expect(resumedScript).toBe(referenceScript);
    expect(resumeProvider.calls.filter((call) => call.task === 'notes').length).toBeLessThan(
      referenceProvider.calls.filter((call) => call.task === 'notes').length,
    );
  });
});
