/** @jest-environment node */
import {
  probeNarrationEngines,
  resetProbeCacheForTests,
  resolveNarrationEngine,
  type NarrationEngineDeps,
} from '@/features/narration/engines';
import { resetSherpaModuleCacheForTests } from '@/features/narration/sherpa';
import { resolveSpeechProvider } from '@/features/audio';

describe('narration engines', () => {
  beforeEach(() => {
    resetProbeCacheForTests();
    resetSherpaModuleCacheForTests();
  });

  it('reports not_installed for piper and kokoro when sherpa is absent', async () => {
    const probes = await probeNarrationEngines();
    expect(probes.device.available).toBe(true);
    expect(probes.piper).toEqual({ available: false, reason: 'not_installed' });
    expect(probes.kokoro).toEqual({ available: false, reason: 'not_installed' });
  });

  it('resolves (never rejects) when every probe throws', async () => {
    const deps: NarrationEngineDeps = {
      probeRemote: async () => {
        throw new Error('remote exploded');
      },
      probeLocal: async () => {
        throw new Error('local exploded');
      },
    };
    const probes = await probeNarrationEngines(deps);
    expect(probes.device.available).toBe(true);
    expect(probes.remote.available).toBe(false);
    expect(probes.piper.available).toBe(false);
    expect(probes.kokoro.available).toBe(false);
  });

  it('memoises probes for the session', async () => {
    let calls = 0;
    const deps: NarrationEngineDeps = {
      probeRemote: async () => ({ available: false, reason: 'no_key' }),
      probeLocal: async () => {
        calls += 1;
        return { available: false, reason: 'not_installed' };
      },
    };
    await probeNarrationEngines(deps);
    await probeNarrationEngines(deps);
    expect(calls).toBe(2); // one call shared by piper and kokoro
  });

  it('falls back to device with a reason for an unavailable kokoro engine', async () => {
    const resolved = await resolveNarrationEngine('kokoro', {
      probeLocal: async () => ({ available: false, reason: 'not_installed' }),
    });
    expect(resolved.engine.id).toBe('device');
    expect(resolved.degraded).toBe(true);
    expect(resolved.reason).toBe('not_installed');
  });

  it('returns remote when available and keyed', async () => {
    const resolved = await resolveNarrationEngine('remote', {
      probeRemote: async () => ({ available: true }),
      remoteConfig: async () => ({
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'local',
        presetId: 'ollama',
      }),
    });
    expect(resolved.engine.id).toBe('remote');
    expect(resolved.engine.producesFiles).toBe(true);
    expect(resolved.degraded).toBe(false);
  });

  it('maps a remote probe without a key to device + no_key', async () => {
    const resolved = await resolveNarrationEngine('remote', {
      probeRemote: async () => ({ available: false, reason: 'no_key' }),
    });
    expect(resolved.engine.id).toBe('device');
    expect(resolved.reason).toBe('no_key');
  });

  it('resolves device without degradation', async () => {
    const resolved = await resolveNarrationEngine('device');
    expect(resolved.engine.id).toBe('device');
    expect(resolved.degraded).toBe(false);
  });

  it('uses the injected local factory when a model is available', async () => {
    const resolved = await resolveNarrationEngine('piper', {
      probeLocal: async () => ({ available: true }),
      createLocalEngine: async (engine) => ({
        id: engine,
        label: 'Fake local',
        producesFiles: true,
        async probe() {
          return { available: true as const };
        },
        async synthesize() {
          return { uri: '', bytes: 0, cached: false, format: 'wav' as const };
        },
      }),
    });
    expect(resolved.engine.id).toBe('piper');
    expect(resolved.degraded).toBe(false);
  });

  it('reports load_failed when the local factory throws', async () => {
    const resolved = await resolveNarrationEngine('kokoro', {
      probeLocal: async () => ({ available: true }),
      createLocalEngine: async () => {
        throw new Error('native init failed');
      },
    });
    expect(resolved.engine.id).toBe('device');
    expect(resolved.degraded).toBe(true);
    expect(resolved.reason).toBe('load_failed');
  });

  it('reports no_model when an available probe yields no factory result', async () => {
    const resolved = await resolveNarrationEngine('piper', {
      probeLocal: async () => ({ available: true }),
      createLocalEngine: async () => null,
    });
    expect(resolved.engine.id).toBe('device');
    expect(resolved.reason).toBe('no_model');
  });

  it('keeps the deprecated shim bound to the resolved engine', async () => {
    const provider = await resolveSpeechProvider();
    expect(provider.engine.id).toBeDefined();
    expect(typeof provider.synthesize).toBe('function');
    await expect(
      provider.synthesize({
        text: 'hello',
        language: 'en-US',
        voice: 'default',
        model: 'tts-1',
        style: 'fireside',
      }),
    ).rejects.toThrow(/audio files|configured|Studio/);
  });
});
