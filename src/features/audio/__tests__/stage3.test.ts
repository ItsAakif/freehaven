/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { listQueue, markQueueItem, nextQueueIndex, syncQueue } from '@/data/repositories/audioQueue';
import { upsertCatalogueBook } from '@/data/repositories/books';
import {
  RemoteSpeechProvider,
  speechCacheKey,
  voicesForLanguage,
  type SpeechCache,
  type SpeechAsset,
} from '@/features/audio/providers';

class MemoryCache implements SpeechCache {
  files = new Map<string, Uint8Array>();
  async get(key: string): Promise<SpeechAsset | null> {
    const bytes = this.files.get(key);
    return bytes ? { uri: `memory://${key}`, bytes: bytes.byteLength, cached: true } : null;
  }
  async put(key: string, bytes: Uint8Array): Promise<SpeechAsset> {
    this.files.set(key, bytes);
    return { uri: `memory://${key}`, bytes: bytes.byteLength, cached: false };
  }
}

const request = { text: 'Hello world.', language: 'en-US', voice: 'alloy', model: 'tts-1' };

describe('speech providers', () => {
  it('derives a stable cache key and changes it with the voice', () => {
    expect(speechCacheKey(request)).toBe(speechCacheKey({ ...request }));
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, voice: 'nova' }));
    expect(speechCacheKey(request)).toMatch(/^narration-[0-9a-f]+$/);
  });

  it('posts to /audio/speech and caches the result', async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls += 1;
        expect(url).toBe('https://speech.test/v1/audio/speech');
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe('tts-1');
        expect(body.voice).toBe('alloy');
        expect(body.response_format).toBe('mp3');
        expect(body.input).toBe('Hello world.');
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const first = await provider.synthesize(request);
    const second = await provider.synthesize(request);
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(cache.files.size).toBe(1);
  });

  it('reports HTTP failures instead of returning silence', async () => {
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache: new MemoryCache(),
      fetchImpl: (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch,
    });
    await expect(provider.synthesize(request)).rejects.toThrow(/429/);
  });

  it('filters device voices by language', () => {
    const voices = [
      { identifier: 'a', name: 'Samantha', language: 'en-US' },
      { identifier: 'b', name: 'Daniel', language: 'en-GB' },
      { identifier: 'c', name: 'Monica', language: 'es-ES' },
    ];
    expect(voicesForLanguage(voices, 'en-GB').map((v) => v.identifier)).toEqual(['b']);
    expect(voicesForLanguage(voices, 'es-ES')).toHaveLength(1);
  });
});

describe('audio queue', () => {
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

  it('reconciles the queue without duplicating sections', async () => {
    const sections = [
      { id: 's1', title: 'One' },
      { id: 's2', title: 'Two' },
    ];
    await syncQueue('b1', sections);
    const second = await syncQueue('b1', [...sections, { id: 's3', title: 'Three' }]);
    expect(second).toHaveLength(3);
    expect(second.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(await listQueue('b1')).toHaveLength(3);
  });

  it('persists status, file path and duration', async () => {
    const [first] = await syncQueue('b1', [{ id: 's1', title: 'One' }]);
    await markQueueItem(first.id, { status: 'ready', filePath: 'file:///a.mp3', duration: 42.5 });
    const [updated] = await listQueue('b1');
    expect(updated.status).toBe('ready');
    expect(updated.filePath).toBe('file:///a.mp3');
    expect(updated.duration).toBe(42.5);
  });

  it('skips finished items when advancing', () => {
    const items = [
      { status: 'done' },
      { status: 'done' },
      { status: 'ready' },
    ] as unknown as Parameters<typeof nextQueueIndex>[0];
    expect(nextQueueIndex(items, 0)).toBe(2);
    expect(nextQueueIndex(items, 2)).toBe(2);
  });
});
