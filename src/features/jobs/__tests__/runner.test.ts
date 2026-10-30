/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { listChunks, replaceExtraction, saveDocument } from '@/data/repositories/reading';
import {
  adoptDoneUnits,
  claimJob,
  createJob,
  getJob,
  getJobPayload,
  listJobUnits,
} from '@/data/repositories/jobs';
import {
  getOrCreateRendition,
  listSegments,
  setRenditionEngine,
} from '@/data/repositories/renditions';
import type { Chunk, Section } from '@/domain/types';
import type { NarrationEngine } from '@/features/narration/engines';
import { instructionHash } from '@/features/narration/script';
import { planWindows } from '@/features/learning/summarise';
import {
  cancelGeneration,
  recoverOnLaunch,
  resumeGeneration,
  startGeneration,
} from '@/features/jobs/runner';
import { setForegroundBridgeForTests } from '@/features/jobs/foreground';

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
  failNotesOn = new Set<number>();
  abortOnNotesCall: number | null = null;
  controller: AbortController | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (request.task === 'notes') {
      const callNumber = this.calls.filter((call) => call.task === 'notes').length;
      if (this.abortOnNotesCall === callNumber) {
        this.controller?.abort();
      }
      if (this.failNotesOn.has(callNumber)) throw new Error('map call failed');
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

async function seedBook(count = 240): Promise<void> {
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
    wordCount: 12_000,
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

describe('generation runner', () => {
  let driver: ReturnType<typeof createTestDriver>;
  let provider: FakeProvider;
  let renditionId: string;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await seedBook();
    provider = new FakeProvider();
    providerRef.current = provider;
    setForegroundBridgeForTests({
      start: async () => {},
      update: async () => {},
      stop: async () => {},
    });
    const rendition = await getOrCreateRendition({
      bookId: BOOK_ID,
      language: 'en-US',
      styleId: 'fireside',
      length: '15',
    });
    renditionId = rendition.id;
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'alloy',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
  });

  afterEach(async () => {
    providerRef.current = null;
    setForegroundBridgeForTests(null);
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('reuses completed map windows after an interrupted run', async () => {
    provider.failNotesOn = new Set([2, 3]);
    const first = await startGeneration({
      renditionId,
      mode: 'script',
      now: 1_000,
    });
    expect(first.kind).toBe('started');
    const firstJobId = first.kind === 'started' ? first.jobId : '';
    const failedWindowCalls = provider.calls.filter((call) => call.task === 'notes').length;
    const doneUnits = (await listJobUnits(firstJobId)).filter(
      (unit) => unit.stage === 'map' && unit.status === 'done',
    ).length;
    expect(doneUnits).toBeGreaterThan(0);

    const secondProvider = new FakeProvider();
    providerRef.current = secondProvider;
    const second = await startGeneration({
      renditionId,
      mode: 'script',
      now: 2_000,
    });
    expect(second.kind).toBe('started');
    const secondCalls = secondProvider.calls.filter((call) => call.task === 'notes').length;
    expect(secondCalls).toBe(failedWindowCalls - doneUnits);
  });

  it('requeues a killed job on boot and resumes without redoing done units', async () => {
    const first = await startGeneration({ renditionId, mode: 'script', now: 1_000 });
    expect(first.kind).toBe('started');
    const firstJobId = first.kind === 'started' ? first.jobId : '';
    const finished = await getJob(firstJobId);
    expect(finished?.status).toBe('done');

    const staleId = await createJob({
      type: 'narration.generate',
      renditionId,
      payload: { mode: 'script' },
      scriptHash: finished?.scriptHash ?? '',
      synthHash: finished?.synthHash ?? '',
      unitsTotal: finished?.unitsTotal ?? 0,
      now: 2_000,
    });
    await adoptDoneUnits({
      fromJobId: firstJobId,
      toJobId: staleId,
      stages: ['map', 'merge', 'reduce', 'expand'],
      now: 2_000,
    });
    await claimJob(staleId, 2_000);

    const recovery = await recoverOnLaunch({ now: 2_500 });
    expect(recovery.recovered).toBe(1);
    expect((await getJob(staleId))?.status).toBe('queued');

    const callsBefore = provider.calls.length;
    const resumed = await resumeGeneration({ jobId: staleId, now: 3_000 });
    expect(resumed.kind).toBe('resumed');
    expect(provider.calls.length).toBe(callsBefore);
    expect((await getJob(staleId))?.status).toBe('done');
  });

  it('keeps completed units when a run is cancelled and reuses them on resume', async () => {
    const controller = new AbortController();
    provider.controller = controller;
    provider.abortOnNotesCall = 2;
    const chunks = await listChunks(DOCUMENT_ID);
    const expectedWindows = planWindows(
      chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
    ).length;
    const cancelled = await startGeneration({
      renditionId,
      mode: 'script',
      now: 1_000,
      signal: controller.signal,
    });
    expect(cancelled.kind).toBe('started');
    const jobId = cancelled.kind === 'started' ? cancelled.jobId : '';
    const job = await getJob(jobId);
    expect(job?.status).toBe('cancelled');
    const doneUnits = (await listJobUnits(jobId)).filter((unit) => unit.status === 'done').length;
    expect(doneUnits).toBeGreaterThan(0);

    const secondProvider = new FakeProvider();
    providerRef.current = secondProvider;
    const resumed = await startGeneration({
      renditionId,
      mode: 'script',
      now: 2_000,
    });
    expect(resumed.kind).toBe('started');
    const mapCalls = secondProvider.calls.filter((call) => call.task === 'notes').length;
    expect(mapCalls).toBe(expectedWindows - doneUnits);
  });

  it('resumes a cancelled job by starting a new job and reusing done units', async () => {
    const controller = new AbortController();
    provider.controller = controller;
    provider.abortOnNotesCall = 2;
    const chunks = await listChunks(DOCUMENT_ID);
    const expectedWindows = planWindows(
      chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
    ).length;
    const cancelled = await startGeneration({
      renditionId,
      mode: 'script',
      now: 1_000,
      signal: controller.signal,
    });
    expect(cancelled.kind).toBe('started');
    const cancelledId = cancelled.kind === 'started' ? cancelled.jobId : '';
    expect((await getJob(cancelledId))?.status).toBe('cancelled');
    const doneUnits = (await listJobUnits(cancelledId)).filter(
      (unit) => unit.status === 'done',
    ).length;
    expect(doneUnits).toBeGreaterThan(0);

    const secondProvider = new FakeProvider();
    providerRef.current = secondProvider;
    const resumed = await resumeGeneration({ jobId: cancelledId, now: 2_000 });
    expect(resumed.kind).toBe('resumed');
    const resumedId = resumed.kind === 'resumed' ? resumed.jobId : '';
    expect(resumedId).not.toBe(cancelledId);
    expect((await getJob(cancelledId))?.status).toBe('cancelled');
    expect((await getJob(resumedId))?.status).toBe('done');
    const mapCalls = secondProvider.calls.filter((call) => call.task === 'notes').length;
    expect(mapCalls).toBe(expectedWindows - doneUnits);
  });

  it('stores the tier budget in the job payload', async () => {
    const started = await startGeneration({ renditionId, mode: 'script', now: 1_000 });
    expect(started.kind).toBe('started');
    const jobId = started.kind === 'started' ? started.jobId : '';
    const payload = (await getJobPayload(jobId)) as {
      mode?: unknown;
      band?: unknown;
      levels?: unknown;
      estimatedCalls?: unknown;
    };
    expect(payload.mode).toBe('script');
    expect(typeof payload.band).toBe('string');
    expect(typeof payload.levels).toBe('number');
    expect(typeof payload.estimatedCalls).toBe('number');
    expect(payload.estimatedCalls as number).toBeGreaterThan(0);
  });

  it('invalidates the script when the instruction changes', async () => {
    await startGeneration({ renditionId, mode: 'script', now: 1_000 });
    const before = provider.calls.filter((call) => call.task === 'notes').length;
    expect(before).toBeGreaterThan(0);

    await setRenditionEngine(renditionId, {
      engine: 'remote',
      voice: 'alloy',
      model: 'tts-1',
      instruction: 'Speak slowly',
      instructionHash: instructionHash('Speak slowly'),
    });
    const secondProvider = new FakeProvider();
    providerRef.current = secondProvider;
    await startGeneration({ renditionId, mode: 'script', now: 2_000 });
    expect(secondProvider.calls.filter((call) => call.task === 'notes').length).toBe(before);
  });

  it('keeps script checkpoints when only the engine changes, and resets synth', async () => {
    const engineA = new FakeEngine('remote');
    await startGeneration({ renditionId, mode: 'all', now: 1_000, engine: engineA });
    const segments = await listSegments(renditionId);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((segment) => segment.status === 'ready')).toBe(true);
    const providerCalls = provider.calls.length;

    await setRenditionEngine(renditionId, {
      engine: 'piper',
      voice: 'piper-voice',
      model: null,
      instruction: null,
      instructionHash: null,
    });
    const engineB = new FakeEngine('piper');
    await startGeneration({ renditionId, mode: 'all', now: 2_000, engine: engineB });

    expect(provider.calls.length).toBe(providerCalls);
    const after = await listSegments(renditionId);
    expect(engineB.calls).toBe(after.length);
    expect(after.every((segment) => segment.status === 'ready')).toBe(true);
  });

  it('never starts two runners for the same rendition', async () => {
    const engine = new FakeEngine('remote');
    const [first, second] = await Promise.all([
      startGeneration({ renditionId, mode: 'all', now: 1_000, engine }),
      startGeneration({ renditionId, mode: 'all', now: 1_000, engine }),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(['already_running', 'started']);
    const jobs = await driver.all<{ id: string }>('SELECT id FROM jobs');
    expect(jobs).toHaveLength(1);
    const segments = await listSegments(renditionId);
    expect(new Set(segments.map((segment) => segment.ordinal)).size).toBe(segments.length);
    const notesCalls = provider.calls.filter((call) => call.task === 'notes').length;
    expect(notesCalls).toBeGreaterThan(0);
  });

  it('drives exactly one foreground lifecycle and reports stage and ETA', async () => {
    const start = jest.fn(async (_input: { title: string; text: string }) => {});
    const update = jest.fn(async (_input: { text: string; progress: number }) => {});
    const stop = jest.fn(async () => {});
    setForegroundBridgeForTests({ start, update, stop });

    const started = await startGeneration({ renditionId, mode: 'script', now: 1_000 });
    expect(started.kind).toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalled();

    const startInput = start.mock.calls[0][0];
    expect(startInput.title).toContain('Compound Interest');
    expect(startInput.text.length).toBeGreaterThan(0);

    const texts = update.mock.calls.map(([input]) => input.text);
    expect(texts.some((text) => text.startsWith('Reading passages - '))).toBe(true);
    expect(texts.every((text) => text.includes(' - '))).toBe(true);
    expect(texts[texts.length - 1]).toMatch(
      /(About .+ left|Less than a minute left|Estimating)/,
    );

    const updateOrders = update.mock.invocationCallOrder;
    expect(stop.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateOrders[updateOrders.length - 1],
    );
  });

  it('never notifies when a job is cancelled before it starts', async () => {
    const start = jest.fn(async () => {});
    const update = jest.fn(async () => {});
    const stop = jest.fn(async () => {});
    setForegroundBridgeForTests({ start, update, stop });

    const jobId = await createJob({
      type: 'narration.generate',
      renditionId,
      payload: { mode: 'script' },
      scriptHash: 'queued-script',
      synthHash: 'queued-synth',
      unitsTotal: 1,
      now: 1_000,
    });
    await cancelGeneration({ jobId, now: 2_000 });

    expect((await getJob(jobId))?.status).toBe('cancelled');
    expect(start).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops the foreground service once when an active job is aborted', async () => {
    const controller = new AbortController();
    provider.controller = controller;
    provider.abortOnNotesCall = 2;
    const start = jest.fn(async () => {});
    const update = jest.fn(async () => {});
    const stop = jest.fn(async () => {});
    setForegroundBridgeForTests({ start, update, stop });

    const started = await startGeneration({
      renditionId,
      mode: 'script',
      now: 1_000,
      signal: controller.signal,
    });
    expect(started.kind).toBe('started');
    const jobId = started.kind === 'started' ? started.jobId : '';
    expect((await getJob(jobId))?.status).toBe('cancelled');
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('completes the job even when the foreground bridge throws', async () => {
    setForegroundBridgeForTests({
      start: () => {
        throw new Error('foreground service unavailable');
      },
      update: async () => {
        throw new Error('foreground service unavailable');
      },
      stop: () => {
        throw new Error('foreground service unavailable');
      },
    });

    const started = await startGeneration({ renditionId, mode: 'script', now: 1_000 });
    expect(started.kind).toBe('started');
    const jobId = started.kind === 'started' ? started.jobId : '';
    expect((await getJob(jobId))?.status).toBe('done');
  });
});
