/**
 * Optional local TTS (sherpa-onnx) adapter.
 *
 * The native package is imported lazily inside `defaultSherpaLoader`, never at
 * module top level: Metro resolves static requires at build time, but Jest must
 * be able to import this module and inject a fake loader instead.
 *
 * Device wiring:
 *   react-native-sherpa-onnx/tts        -> createTTS, detectTtsModel
 *   react-native-sherpa-onnx/extraction -> listBundledArchives, extractArchive
 *
 * When the package is absent (or its subpaths cannot be evaluated) every entry
 * point degrades to a structured `not_installed` result instead of throwing.
 */

import type { SpeechAsset, SpeechRequest } from '@/features/audio/providers';
import type { SpeechTiming } from '@/domain/narration';
import type { EngineAvailability, NarrationEngine } from './engines';
import { encodeWav, normalisePeak } from './wav';

export type SherpaModelPath = {
  type: 'file' | 'asset' | 'auto';
  path: string;
};

export interface SherpaGeneratedAudio {
  samples: number[] | Float32Array;
  sampleRate: number;
}

/** Word/subtitle timing in seconds, as the native module reports it. */
export interface SherpaSubtitle {
  text: string;
  start: number;
  end: number;
}

export interface SherpaTimedAudio extends SherpaGeneratedAudio {
  subtitles?: SherpaSubtitle[];
}

/** Minimal TTS handle shape; the real package also exposes getNumSpeakers(). */
export interface SherpaHandle {
  generateSpeechWithTimestamps?(
    text: string,
    options?: {
      sid?: number;
      speed?: number;
      subtitles?: { mode?: 'fast' | 'slow'; granularity?: 'word' | 'sentence' };
    },
  ): Promise<SherpaTimedAudio> | SherpaTimedAudio;
  generateSpeech?(
    text: string,
    options?: { sid?: number; speed?: number },
  ): Promise<SherpaGeneratedAudio> | SherpaGeneratedAudio;
  /** Legacy/test shape used by `createSherpaEngine`. */
  generate?(input: {
    text: string;
    speakerId?: number;
    speed?: number;
  }): Promise<SherpaGeneratedAudio> | SherpaGeneratedAudio;
  getNumSpeakers?(): Promise<number> | number;
  getSampleRate?(): Promise<number> | number;
  destroy?(): Promise<void> | void;
  free?(): void | Promise<void>;
}

export interface SherpaArchive {
  archivePath: string;
  modelId?: string;
  format?: 'tar.zst' | 'tar.bz2';
  fileSize?: number;
  fromAsset?: boolean;
}

export type SherpaExtractProgress = { percent: number };

export interface SherpaExtractionResult {
  success: boolean;
  path?: string;
}

/** Only the members the adapter actually uses. */
export type SherpaModule = {
  createTTS(
    options: {
      modelPath: SherpaModelPath;
      modelType?: 'vits' | 'kokoro' | 'auto';
      numThreads?: number;
    },
  ): Promise<SherpaHandle> | SherpaHandle;
  detectTtsModel?(
    modelPath: SherpaModelPath,
    options?: { modelType?: string },
  ): Promise<{ success: boolean; modelType?: string; error?: string }> | {
    success: boolean;
    modelType?: string;
    error?: string;
  };
  listBundledArchives?(dirPath: string): Promise<SherpaArchive[]> | SherpaArchive[];
  extractArchive?(
    archive: SherpaArchive,
    targetDir: string,
    options?: {
      force?: boolean;
      onProgress?: (event: SherpaExtractProgress) => void;
      showNotificationsEnabled?: boolean;
    },
  ): Promise<SherpaExtractionResult> | SherpaExtractionResult;
};

export type SherpaLoader = () => SherpaModule | null;

function isSherpaModule(value: unknown): value is SherpaModule {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.createTTS !== 'function') return false;
  if (
    candidate.listBundledArchives !== undefined &&
    typeof candidate.listBundledArchives !== 'function'
  ) {
    return false;
  }
  if (candidate.extractArchive !== undefined && typeof candidate.extractArchive !== 'function') {
    return false;
  }
  return true;
}

/**
 * Real loader. Both requires stay inside the function so importing this module
 * (e.g. in Jest) never touches the native package.
 */
function defaultSherpaLoader(): SherpaModule | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tts = require('react-native-sherpa-onnx/tts') as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const extraction = require('react-native-sherpa-onnx/extraction') as Record<string, unknown>;

  if (
    typeof tts.createTTS !== 'function' ||
    typeof extraction.listBundledArchives !== 'function' ||
    typeof extraction.extractArchive !== 'function'
  ) {
    return null;
  }

  return {
    createTTS: tts.createTTS as SherpaModule['createTTS'],
    detectTtsModel:
      typeof tts.detectTtsModel === 'function'
        ? (tts.detectTtsModel as SherpaModule['detectTtsModel'])
        : undefined,
    listBundledArchives: extraction.listBundledArchives as NonNullable<
      SherpaModule['listBundledArchives']
    >,
    extractArchive: extraction.extractArchive as NonNullable<SherpaModule['extractArchive']>,
  };
}

let cachedModule: SherpaModule | null | undefined;
let cachedLoader: SherpaLoader | undefined;

/** Memoised guarded load. Never throws; invalid packages count as absent. */
export function loadSherpaModule(loader: SherpaLoader = defaultSherpaLoader): SherpaModule | null {
  if (cachedModule !== undefined && cachedLoader === loader) return cachedModule;
  cachedLoader = loader;
  try {
    const loaded = loader();
    cachedModule = isSherpaModule(loaded) ? loaded : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function resetSherpaModuleCacheForTests(): void {
  cachedModule = undefined;
  cachedLoader = undefined;
  localEngines.clear();
}

/** Probe the optional module without running model inference or touching the network. */
export async function probeSherpa(loader?: SherpaLoader): Promise<EngineAvailability> {
  try {
    const mod = loadSherpaModule(loader);
    if (!mod) return { available: false, reason: 'not_installed' };
    return {
      available: true,
      detail: 'Local voice engine loaded',
    };
  } catch (error) {
    return {
      available: false,
      reason: 'not_installed',
      detail: error instanceof Error ? error.message : undefined,
    };
  }
}

async function defaultWriteFile(path: string, bytes: Uint8Array): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File } = require('expo-file-system') as typeof import('expo-file-system');
  const file = new File(path);
  if (file.exists) file.delete();
  file.create();
  await file.write(bytes);
}

async function synthesizeWithHandle(
  handle: SherpaHandle,
  input: { text: string; speakerId?: number; speed?: number },
): Promise<SherpaTimedAudio> {
  if (typeof handle.generateSpeechWithTimestamps === 'function') {
    return handle.generateSpeechWithTimestamps(input.text, {
      sid: input.speakerId,
      speed: input.speed ?? 1,
      subtitles: { mode: 'fast', granularity: 'word' },
    });
  }
  if (typeof handle.generateSpeech === 'function') {
    return handle.generateSpeech(input.text, {
      sid: input.speakerId,
      speed: input.speed ?? 1,
    });
  }
  if (typeof handle.generate === 'function') {
    return handle.generate(input);
  }
  throw new Error('Sherpa TTS handle exposes no synthesis function.');
}

function toFloat32(samples: number[] | Float32Array): Float32Array {
  return samples instanceof Float32Array ? samples : Float32Array.from(samples);
}

/** Seconds → milliseconds, dropping blank or inverted entries. */
export function timingsFromSubtitles(
  subtitles: SherpaSubtitle[] | undefined,
): SpeechTiming[] | undefined {
  if (!subtitles?.length) return undefined;
  const timings = subtitles
    .filter((item) => typeof item?.text === 'string' && item.text.trim().length > 0)
    .map((item) => ({
      text: item.text,
      startMs: Math.max(0, Math.round(item.start * 1000)),
      endMs: Math.max(0, Math.round(item.end * 1000)),
    }))
    .filter((item) => item.endMs >= item.startMs);
  return timings.length ? timings : undefined;
}

type EngineWithHandleOptions = {
  modelDir: string;
  modelType?: 'vits' | 'kokoro';
  /** Preference override; wins over `request.speakerId`. */
  speakerId?: number;
  numSpeakers?: number;
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
};

function engineWithHandle(
  engine: 'piper' | 'kokoro',
  getHandle: () => Promise<SherpaHandle>,
  options: EngineWithHandleOptions,
): NarrationEngine {
  const writeFile = options.writeFile ?? defaultWriteFile;

  return {
    id: engine,
    label: engine === 'kokoro' ? 'Kokoro (local)' : 'Piper (local)',
    producesFiles: true,
    async probe(): Promise<EngineAvailability> {
      return { available: true, detail: `${options.modelType ?? engine} · ${options.modelDir}` };
    },
    async synthesize(request: SpeechRequest): Promise<SpeechAsset> {
      const handle = await getHandle();
      const result = await synthesizeWithHandle(handle, {
        text: request.text,
        speakerId: options.speakerId ?? request.speakerId,
        speed: request.speed ?? 1,
      });
      const samples = normalisePeak(toFloat32(result.samples), 0.95);
      const bytes = encodeWav(samples, result.sampleRate);
      const destPath = request.destPath;
      const timings = timingsFromSubtitles(result.subtitles);

      if (destPath) await writeFile(destPath, bytes);

      return {
        uri: destPath ?? '',
        bytes: bytes.byteLength,
        cached: false,
        format: 'wav',
        ...(timings ? { timings } : {}),
      };
    },
  };
}

/**
 * Legacy constructor used by tests: wrap an already-created native handle.
 * Kept because the handle-level path is useful when a caller owns the module.
 */
export function createSherpaEngine(input: {
  engine: 'piper' | 'kokoro';
  modelDir: string;
  modelType: 'vits' | 'kokoro';
  handle: SherpaHandle;
  module?: SherpaModule;
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}): NarrationEngine {
  return engineWithHandle(input.engine, async () => input.handle, {
    modelDir: input.modelDir,
    modelType: input.modelType,
    writeFile: input.writeFile,
  });
}

export type LocalEngineOptions = EngineWithHandleOptions & {
  loader?: SherpaLoader;
  numThreads?: number;
};

export interface LocalNarrationEngine extends NarrationEngine {
  /** Voices advertised by the manifest bundle (Kokoro: 103, Piper: 1). */
  readonly numSpeakers: number;
  /** Create (once) and return the native handle. */
  load(): Promise<SherpaHandle>;
  /** Free the native handle; the next synthesize loads it again. */
  destroy(): Promise<void>;
}

const localEngines = new Map<string, Promise<SherpaHandle>>();

function localHandleKey(engine: 'piper' | 'kokoro', modelDir: string): string {
  return `${engine}:${modelDir}`;
}

/**
 * Real local engine: loads the sherpa module lazily, creates one native handle
 * per engine/model directory, and encodes every result with `encodeWav`.
 */
export function createLocalEngine(
  engine: 'piper' | 'kokoro',
  options: LocalEngineOptions,
): LocalNarrationEngine {
  const module = loadSherpaModule(options.loader);
  const key = localHandleKey(engine, options.modelDir);
  const numSpeakers = options.numSpeakers ?? (engine === 'kokoro' ? 103 : 1);

  const load = (): Promise<SherpaHandle> => {
    if (!module) return Promise.reject(new Error('not_installed'));
    const existing = localEngines.get(key);
    if (existing) return existing;

    const pending = Promise.resolve(
      module.createTTS({
        modelPath: { type: 'file', path: options.modelDir },
        modelType: options.modelType ?? (engine === 'kokoro' ? 'kokoro' : 'vits'),
        numThreads: options.numThreads ?? 2,
      }),
    );
    localEngines.set(key, pending);
    // A failed create must not poison later attempts.
    pending.catch(() => {
      if (localEngines.get(key) === pending) localEngines.delete(key);
    });
    return pending;
  };

  const base = engineWithHandle(engine, load, {
    ...options,
    numSpeakers,
  });

  return {
    ...base,
    numSpeakers,
    async probe(): Promise<EngineAvailability> {
      if (!module) return { available: false, reason: 'not_installed' };
      return { available: true, detail: `${options.modelType ?? engine} · ${options.modelDir}` };
    },
    load,
    async destroy(): Promise<void> {
      const pending = localEngines.get(key);
      localEngines.delete(key);
      if (!pending) return;
      try {
        const handle = await pending;
        await freeSherpaHandle(handle);
      } catch {
        /* load failed, nothing to free */
      }
    },
  };
}

/** Release a model handle when the Listen screen unmounts or the engine changes. */
export async function freeSherpaHandle(handle: SherpaHandle): Promise<void> {
  try {
    if (typeof handle.destroy === 'function') await handle.destroy();
    else await handle.free?.();
  } catch {
    /* the native side may already be gone */
  }
}
