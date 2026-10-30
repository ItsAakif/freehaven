/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { listQueue, syncQueue } from '@/data/repositories/audioQueue';
import { upsertCatalogueBook } from '@/data/repositories/books';
import {
  getOrCreateRendition,
  listSegments,
  replaceSegments,
  setRenditionEngine,
} from '@/data/repositories/renditions';
import { downloadRendition, downloadSections } from '@/features/audio/download';
import type { SpeechAsset } from '@/features/audio/providers';
import type { NarrationEngine } from '@/features/narration/engines';
import { planSpeechSegments } from '@/features/narration/segments';

class FakeEngine implements NarrationEngine {
  readonly id = 'remote' as const;
  readonly label = 'Fake';
  readonly producesFiles = true;
  calls = 0;
  failOnCall: number | null = null;

  async probe() {
    return { available: true as const };
  }

  async synthesize(request: Parameters<NarrationEngine['synthesize']>[0]): Promise<SpeechAsset> {
    this.calls += 1;
    if (this.failOnCall === this.calls) throw new Error('offline');
    return {
      uri: `memory://segment-${this.calls}.${request.format}`,
      bytes: request.text.length,
      cached: false,
      format: request.format,
    };
  }
}

const longText = Array.from(
  { length: 140 },
  (_, index) =>
    `Sentence ${index} explains how compound interest grows the principal when reinvested over time.`,
).join(' ');

describe('rendition download', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await upsertCatalogueBook({
      id: 'b1',
      provider: 'gutendex',
      title: 'Book',
      subjects: [],
      source: 'gutenberg',
      sourceId: 'b1',
      access: 'public_domain',
    });
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* closed */
    }
  });

  async function seedLongRendition(): Promise<string> {
    const rendition = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en-US',
      styleId: 'fireside',
      length: '5',
    });
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'nova',
      model: 'tts-1',
      instruction: null,
      instructionHash: null,
    });
    const pieces = planSpeechSegments(longText, 3_800);
    expect(pieces.length).toBeGreaterThan(1);
    await replaceSegments(
      rendition.id,
      pieces.map((piece, index) => ({
        sectionId: null,
        sectionOrdinal: 0,
        title: index === 0 ? 'One' : null,
        text: piece.text,
        speechKey: `narr2-${String(index).padStart(16, '0')}`,
      })),
    );
    return rendition.id;
  }

  it('synthesises a 9 000-character section in at least two pieces without losing text', async () => {
    const renditionId = await seedLongRendition();
    expect(longText.length).toBeGreaterThan(9_000);
    const segments = await listSegments(renditionId);
    expect(segments.length).toBeGreaterThanOrEqual(2);

    const progress: { done: number; total: number; failed: number }[] = [];
    const engine = new FakeEngine();
    const result = await downloadRendition({
      renditionId,
      engine,
      onProgress: (update) => progress.push(update),
    });

    expect(result.failed).toBe(0);
    expect(result.done).toBe(segments.length);
    expect(progress).toHaveLength(segments.length + 1);
    expect(progress[progress.length - 1]).toEqual({
      done: segments.length,
      total: segments.length,
      failed: 0,
    });

    const stored = await listSegments(renditionId);
    const joined = stored.map((segment) => segment.text).join(' ');
    expect(joined).toContain(longText.slice(0, 40));
    for (const sentence of longText.match(/Sentence \d+/g) ?? []) {
      expect(joined).toContain(sentence);
    }
  });

  it('records failures and leaves the failing segment retryable', async () => {
    const renditionId = await seedLongRendition();
    const engine = new FakeEngine();
    engine.failOnCall = 3;

    const result = await downloadRendition({ renditionId, engine });
    expect(result.failed).toBe(1);
    expect(result.done).toBeGreaterThanOrEqual(2);

    const segments = await listSegments(renditionId);
    expect(segments[0].status).toBe('ready');
    expect(segments[1].status).toBe('ready');
    expect(segments[2].status).toBe('failed');

    const retried = await downloadRendition({ renditionId, engine: new FakeEngine() });
    expect(retried.failed).toBe(0);
    expect((await listSegments(renditionId)).every((segment) => segment.status === 'ready')).toBe(
      true,
    );
  });

  it('keeps the legacy section wrapper segment-based (no 4 000-char slice)', async () => {
    const sections = [{ id: 's1', title: 'One', text: longText }];
    const queue = await syncQueue('b1', sections);
    const requests: string[] = [];
    const provider = {
      async synthesize(request: { text: string }): Promise<SpeechAsset> {
        requests.push(request.text);
        return { uri: `file:///audio-${requests.length}.mp3`, bytes: 10, cached: false, format: 'mp3' };
      },
    };
    const progress = await downloadSections({
      queue,
      sections,
      provider,
      voice: 'nova',
      model: 'tts-1',
      language: 'en-US',
      style: 'fireside',
    });
    expect(progress.done).toBe(1);
    expect(progress.failed).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every((text) => text.length <= 3_800)).toBe(true);
    const joined = requests.join(' ');
    expect(joined).toContain(longText.slice(0, 40));
    expect((await listQueue('b1'))[0].status).toBe('ready');
  });
});
