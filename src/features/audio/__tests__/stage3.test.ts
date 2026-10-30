/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { listQueue, markQueueItem, nextQueueIndex, syncQueue } from '@/data/repositories/audioQueue';
import { upsertCatalogueBook } from '@/data/repositories/books';
import {
  DeviceSpeechProvider,
  RemoteSpeechProvider,
  UnsupportedOperationError,
  speechCacheKey,
  voicesForLanguage,
  type SpeechAsset,
  type SpeechCache,
  type SpeechRequest,
} from '@/features/audio/providers';

class MemoryCache implements SpeechCache {
  files = new Map<string, { bytes: Uint8Array; format: string }>();
  async get(key: string, format?: 'mp3' | 'wav'): Promise<SpeechAsset | null> {
    const formats = format ? [format] : (['mp3', 'wav'] as const);
    for (const candidate of formats) {
      const entry = this.files.get(`${key}.${candidate}`);
      if (entry) {
        return { uri: `memory://${key}.${candidate}`, bytes: entry.bytes.byteLength, cached: true, format: candidate };
      }
    }
    return null;
  }
  async put(key: string, bytes: Uint8Array, format: 'mp3' | 'wav' = 'mp3'): Promise<SpeechAsset> {
    this.files.set(`${key}.${format}`, { bytes, format });
    return { uri: `memory://${key}.${format}`, bytes: bytes.byteLength, cached: false, format };
  }
  async putAt(destPath: string, bytes: Uint8Array, format: 'mp3' | 'wav'): Promise<SpeechAsset> {
    this.files.set(destPath, { bytes, format });
    return { uri: destPath, bytes: bytes.byteLength, cached: false, format };
  }
}

const request: SpeechRequest = {
  text: 'Hello world.',
  language: 'en-US',
  voice: 'alloy',
  model: 'tts-1',
  engine: 'remote',
  styleId: 'fireside',
  instructionHash: '',
  format: 'mp3',
};

function response(
  bytes: Uint8Array,
  contentType: string,
  status = 200,
  ok = status >= 200 && status < 300,
): Response {
  return {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? contentType : null,
    },
    arrayBuffer: async () => bytes.buffer,
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as Response;
}

describe('speech providers', () => {
  it('derives a stable v2 cache key from every input', () => {
    expect(speechCacheKey(request)).toBe(speechCacheKey({ ...request }));
    expect(speechCacheKey(request)).toMatch(/^narr2-[0-9a-f]{16}$/);
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, voice: 'nova' }));
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, model: 'tts-1-hd' }));
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, language: 'en-GB' }));
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, engine: 'kokoro' }));
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, format: 'wav' }));
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, styleId: 'brief' }));
    expect(speechCacheKey(request)).not.toBe(
      speechCacheKey({ ...request, instructionHash: 'abcd1234' }),
    );
    expect(speechCacheKey(request)).not.toBe(
      speechCacheKey({ ...request, baseUrl: 'https://one.test/v1' }),
    );
    expect(speechCacheKey(request)).not.toBe(
      speechCacheKey({ ...request, baseUrl: 'https://two.test/v1' }),
    );
    expect(speechCacheKey(request)).not.toBe(speechCacheKey({ ...request, text: 'Other.' }));
  });

  it('ignores base URL path changes and treats trailing slashes equally', () => {
    expect(
      speechCacheKey({ ...request, baseUrl: 'https://speech.test/v1' }),
    ).toBe(speechCacheKey({ ...request, baseUrl: 'https://SPEECH.test/v2/' }));
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
        return response(new Uint8Array([1, 2, 3, 4]), 'audio/mpeg');
      }) as unknown as typeof fetch,
    });
    const first = await provider.synthesize(request);
    const second = await provider.synthesize(request);
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.format).toBe('mp3');
    expect(cache.files.size).toBe(1);
  });

  it('omits response_format when the endpoint does not support it', async () => {
    let body: Record<string, unknown> = {};
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      presetId: 'ollama',
      cache: new MemoryCache(),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return response(new Uint8Array([1, 2, 3]), 'audio/mpeg');
      }) as unknown as typeof fetch,
    });
    await provider.synthesize(request);
    expect(body.response_format).toBeUndefined();
  });

  it('retries once without response_format when a 400 mentions it', async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache: new MemoryCache(),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls += 1;
        bodies.push(JSON.parse(String(init.body)));
        if (calls === 1) {
          return response(
            new TextEncoder().encode('{"error":"response_format is not supported"}'),
            'application/json',
            400,
          );
        }
        return response(new Uint8Array([9, 8, 7]), 'audio/mpeg');
      }) as unknown as typeof fetch,
    });
    const asset = await provider.synthesize(request);
    expect(calls).toBe(2);
    expect(bodies[0].response_format).toBe('mp3');
    expect(bodies[1].response_format).toBeUndefined();
    expect(asset.format).toBe('mp3');
  });

  it('detects WAV from the content type and writes a .wav cache file', async () => {
    const cache = new MemoryCache();
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache,
      fetchImpl: (async () =>
        response(new Uint8Array([82, 73, 70, 70]), 'audio/wav')) as unknown as typeof fetch,
    });
    const asset = await provider.synthesize({ ...request, format: 'wav' });
    expect(asset.format).toBe('wav');
    expect(cache.files.has(`${speechCacheKey({ ...request, format: 'wav' })}.wav`)).toBe(true);
  });

  it('throws with the body preview when a JSON body arrives with ok:true', async () => {
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache: new MemoryCache(),
      fetchImpl: (async () =>
        response(
          new TextEncoder().encode('{"ok":true,"error":"no audio"}'),
          'application/json',
        )) as unknown as typeof fetch,
    });
    await expect(provider.synthesize(request)).rejects.toThrow(/no audio/);
  });

  it('writes destPath and returns it as the uri', async () => {
    const cache = new MemoryCache();
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache,
      fetchImpl: (async () =>
        response(new Uint8Array([1, 2, 3]), 'audio/wav')) as unknown as typeof fetch,
    });
    const asset = await provider.synthesize({
      ...request,
      format: 'wav',
      destPath: 'renditions/rd1/0.wav',
    });
    expect(asset.uri).toBe('renditions/rd1/0.wav');
    expect(asset.format).toBe('wav');
    expect(cache.files.has('renditions/rd1/0.wav')).toBe(true);
  });

  it('rewrites a .mp3 destPath when the endpoint returns WAV', async () => {
    const cache = new MemoryCache();
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache,
      fetchImpl: (async () =>
        response(new Uint8Array([82, 73, 70, 70]), 'audio/wav')) as unknown as typeof fetch,
    });
    const asset = await provider.synthesize({
      ...request,
      format: 'mp3',
      destPath: 'renditions/rd1/0.mp3',
    });
    expect(asset.uri).toBe('renditions/rd1/0.wav');
    expect(asset.format).toBe('wav');
    expect(cache.files.has('renditions/rd1/0.wav')).toBe(true);
    expect(cache.files.has('renditions/rd1/0.mp3')).toBe(false);
  });

  it('rewrites a .wav destPath when the endpoint returns MP3', async () => {
    const cache = new MemoryCache();
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache,
      fetchImpl: (async () =>
        response(new Uint8Array([255, 251, 90, 0]), 'audio/mpeg')) as unknown as typeof fetch,
    });
    const asset = await provider.synthesize({
      ...request,
      format: 'wav',
      destPath: 'renditions/rd1/0.wav',
    });
    expect(asset.uri).toBe('renditions/rd1/0.mp3');
    expect(asset.format).toBe('mp3');
    expect(cache.files.has('renditions/rd1/0.mp3')).toBe(true);
    expect(cache.files.has('renditions/rd1/0.wav')).toBe(false);
  });

  it('adds instructions only for models that accept them', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache: new MemoryCache(),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return response(new Uint8Array([1]), 'audio/mpeg');
      }) as unknown as typeof fetch,
    });
    await provider.synthesize({ ...request, model: 'tts-1', instructions: 'Warm.' });
    await provider.synthesize({ ...request, model: 'gpt-4o-mini-tts', instructions: 'Warm.' });
    expect(bodies[0].instructions).toBeUndefined();
    expect(bodies[1].instructions).toBe('Warm.');
  });

  it('reports HTTP failures instead of returning silence', async () => {
    const provider = new RemoteSpeechProvider({
      baseUrl: 'https://speech.test/v1',
      apiKey: 'secret',
      cache: new MemoryCache(),
      fetchImpl: (async () =>
        response(new Uint8Array(), 'text/plain', 429, false)) as unknown as typeof fetch,
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

  it('device speech never produces files', async () => {
    const provider = new DeviceSpeechProvider();
    expect(provider.producesFiles).toBe(false);
    await expect(provider.synthesize(request)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
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
