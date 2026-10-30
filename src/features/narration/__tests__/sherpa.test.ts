import {
  createLocalEngine,
  createSherpaEngine,
  loadSherpaModule,
  probeSherpa,
  resetSherpaModuleCacheForTests,
  type SherpaHandle,
  type SherpaModule,
} from '@/features/narration/sherpa';
import type { SpeechRequest } from '@/features/audio/providers';

function speechRequest(overrides: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    text: 'hello',
    language: 'en-US',
    voice: 'default',
    model: 'piper',
    engine: 'piper',
    styleId: 'fireside',
    instructionHash: '',
    format: 'wav',
    ...overrides,
  };
}

describe('sherpa adapter', () => {
  beforeEach(() => resetSherpaModuleCacheForTests());

  it('reports not_installed when the loader throws', async () => {
    const result = await probeSherpa(() => {
      throw new Error('Cannot find module react-native-sherpa-onnx');
    });
    expect(result).toEqual({ available: false, reason: 'not_installed' });
  });

  it('reports not_installed for the default loader', async () => {
    expect(await probeSherpa()).toEqual({ available: false, reason: 'not_installed' });
  });

  it('validates the module shape before reporting available', async () => {
    const invalid = { createTTS: 'nope' } as unknown as SherpaModule;
    expect(loadSherpaModule(() => invalid)).toBeNull();

    const valid = { createTTS: () => ({}) } as unknown as SherpaModule;
    expect(loadSherpaModule(() => valid)).toBe(valid);
    expect(await probeSherpa(() => valid)).toMatchObject({ available: true });
  });

  it('encodes a WAV and writes it to destPath', async () => {
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const engine = createSherpaEngine({
      engine: 'piper',
      modelDir: 'models/piper',
      modelType: 'vits',
      handle: {
        generate: () => ({ samples: new Float32Array([0, 0.5, -0.5]), sampleRate: 24_000 }),
        free: () => undefined,
      },
      writeFile: async (path, bytes) => {
        writes.push({ path, bytes });
      },
    });

    const asset = await engine.synthesize({
      text: 'hello',
      language: 'en-US',
      voice: 'default',
      model: 'piper',
      engine: 'piper',
      styleId: 'fireside',
      instructionHash: '',
      format: 'wav',
      destPath: 'renditions/rd/0.wav',
    });

    expect(asset.uri).toBe('renditions/rd/0.wav');
    expect(asset.format).toBe('wav');
    expect(writes).toHaveLength(1);
    expect(String.fromCharCode(...writes[0].bytes.slice(0, 4))).toBe('RIFF');
  });

  it('creates one local handle per engine and reuses it', async () => {
    let creations = 0;
    const destroyed: string[] = [];
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const seen: { text: string; sid?: number; speed?: number }[] = [];
    const handle: SherpaHandle = {
      generateSpeech: (text, options) => {
        seen.push({ text, sid: options?.sid, speed: options?.speed });
        return { samples: [0, 0.5, -0.5], sampleRate: 24_000 };
      },
      getNumSpeakers: async () => 103,
      destroy: async () => {
        destroyed.push('handle');
      },
    };
    const module: SherpaModule = {
      createTTS: async () => {
        creations += 1;
        return handle;
      },
    };

    const engine = createLocalEngine('kokoro', {
      modelDir: '/models/kokoro',
      modelType: 'kokoro',
      speakerId: 7,
      numSpeakers: 103,
      loader: () => module,
      writeFile: async (path, bytes) => {
        writes.push({ path, bytes });
      },
    });

    expect(engine.numSpeakers).toBe(103);
    expect(await engine.probe()).toMatchObject({ available: true });

    await engine.synthesize(speechRequest({ destPath: 'renditions/rd/0.wav', speed: 1.25 }));
    await engine.synthesize(speechRequest({ destPath: 'renditions/rd/1.wav' }));

    expect(creations).toBe(1);
    expect(writes).toHaveLength(2);
    expect(String.fromCharCode(...writes[0].bytes.slice(0, 4))).toBe('RIFF');
    expect(seen[0]).toEqual({ text: 'hello', sid: 7, speed: 1.25 });
    expect(seen[1]).toEqual({ text: 'hello', sid: 7, speed: 1 });

    await engine.destroy();
    expect(destroyed).toHaveLength(1);

    await engine.synthesize(speechRequest({ destPath: 'renditions/rd/2.wav' }));
    expect(creations).toBe(2);
  });

  it('reports not_installed and rejects synthesis when the module is absent', async () => {
    const engine = createLocalEngine('piper', {
      modelDir: '/models/piper',
      loader: () => null,
    });

    expect(await engine.probe()).toEqual({ available: false, reason: 'not_installed' });
    await expect(engine.synthesize(speechRequest())).rejects.toThrow('not_installed');
  });
});
