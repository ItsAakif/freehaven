/**
 * Narration engine resolution.
 *
 * Types and probes only: no engine is constructed at import time and no probe
 * performs network I/O. The native sherpa module is optional and guarded inside
 * `sherpa.ts`; when absent, local engines simply report `not_installed`.
 */

import type { RenditionEngine } from '@/domain/narration';
import type {
  SpeechAsset,
  SpeechCache,
  SpeechRequest,
  SpeechSynthesisProvider,
} from '@/features/audio/providers';
import { getPreset } from '@/ai/presets';
import { MODEL_BUNDLES } from './models';
import { createLocalEngine, loadSherpaModule } from './sherpa';

export type EngineUnavailableReason =
  | 'not_installed'
  | 'no_model'
  | 'load_failed'
  | 'model_absent'
  | 'model_unverified'
  | 'needs_extraction'
  | 'no_key'
  | 'no_base_url'
  | 'unsupported_platform';

export type EngineAvailability =
  | { available: true; detail?: string }
  | { available: false; reason: EngineUnavailableReason; detail?: string };

export interface NarrationEngine {
  readonly id: RenditionEngine;
  readonly label: string;
  readonly producesFiles: boolean;
  probe(): Promise<EngineAvailability>;
  synthesize(request: SpeechRequest): Promise<SpeechAsset>;
  /** Local engines: number of speakers/voices in the installed model. */
  readonly numSpeakers?: number;
  /** Local engines: release the native handle. */
  destroy?(): Promise<void>;
  /** Engine-specific voice catalogue for the picker; empty when fixed single-voice. */
  voices?(): Promise<{ id: string; label: string; language: string }[]>;
}

export type RemoteEngineConfig = {
  baseUrl: string;
  apiKey: string;
  presetId?: string;
  fetchImpl?: typeof fetch;
  cache?: SpeechCache;
};

export type NarrationEngineDeps = {
  /** Defaults to the persisted preference/key probe. */
  probeRemote?: () => Promise<EngineAvailability>;
  /** Defaults to `probeSherpa` (module presence only). */
  probeLocal?: () => Promise<EngineAvailability>;
  remoteConfig?: () => Promise<RemoteEngineConfig | null>;
  /** Optional hook so C5/D can construct a real local engine once a model is ready. */
  createLocalEngine?: (engine: 'piper' | 'kokoro') => Promise<NarrationEngine | null>;
};

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function deviceEngine(): NarrationEngine {
  return {
    id: 'device',
    label: 'Device voice',
    producesFiles: false,
    async probe() {
      return { available: true };
    },
    async synthesize() {
      const error = new Error('Device speech does not produce audio files.');
      error.name = 'UnsupportedOperationError';
      throw error;
    },
  };
}

function remoteEngine(config: RemoteEngineConfig): NarrationEngine {
  let provider: SpeechSynthesisProvider | null = null;
  const resolveProvider = (): SpeechSynthesisProvider => {
    if (!provider) {
      // Lazy require keeps expo-file-system out of modules imported by Jest
      // until a remote synthesis is actually requested.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RemoteSpeechProvider } = require('@/features/audio/providers') as typeof import('@/features/audio/providers');
      provider = new RemoteSpeechProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        presetId: config.presetId,
        fetchImpl: config.fetchImpl,
        cache: config.cache,
      });
    }
    return provider;
  };

  return {
    id: 'remote',
    label: 'Remote voice',
    producesFiles: true,
    async probe() {
      if (!config.baseUrl) return { available: false, reason: 'no_base_url' };
      if (!config.apiKey) return { available: false, reason: 'no_key' };
      return { available: true };
    },
    async synthesize(request) {
      return resolveProvider().synthesize(request);
    },
  };
}

async function defaultRemoteAvailability(): Promise<EngineAvailability> {
  // Lazy requires: `preferences` pulls Expo kv-store, which tests mock.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { usePreferences } = require('@/state/preferences') as typeof import('@/state/preferences');
    const prefs = usePreferences.getState();
    const baseUrl = (prefs.aiBaseUrl ?? '').trim();
    if (!baseUrl) return { available: false, reason: 'no_base_url' };

    let hasKey = prefs.aiKeyPresent;
    if (!hasKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getStoredKey } = require('@/ai') as typeof import('@/ai');
        hasKey = !!(await getStoredKey());
      } catch {
        hasKey = false;
      }
    }

    if (!hasKey && getPreset(prefs.aiPreset).requiresKey) {
      return { available: false, reason: 'no_key' };
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: 'no_key', detail: errorMessage(error) };
  }
}

async function defaultRemoteConfig(): Promise<RemoteEngineConfig | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { usePreferences } = require('@/state/preferences') as typeof import('@/state/preferences');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getStoredKey } = require('@/ai') as typeof import('@/ai');
    const prefs = usePreferences.getState();
    const baseUrl = (prefs.aiBaseUrl ?? '').trim();
    if (!baseUrl) return null;
    const apiKey = await getStoredKey();
    if (!apiKey && getPreset(prefs.aiPreset).requiresKey) return null;
    return {
      baseUrl,
      apiKey: apiKey ?? '',
      presetId: prefs.aiPreset,
    };
  } catch {
    return null;
  }
}

async function safeProbe(
  probe: () => Promise<EngineAvailability>,
  fallback: EngineUnavailableReason,
): Promise<EngineAvailability> {
  try {
    return await probe();
  } catch (error) {
    return { available: false, reason: fallback, detail: errorMessage(error) };
  }
}

type LocalEngineKind = 'piper' | 'kokoro';

type InstalledBundle = {
  bundle: (typeof MODEL_BUNDLES)[number];
  modelDir: string;
};

/**
 * Find a verified local bundle for an engine. The row is written by the
 * Settings download/verify flow only after extraction and file verification.
 * Lazy require keeps SQLite out of modules that merely import the type.
 */
async function installedBundleFor(engine: LocalEngineKind): Promise<InstalledBundle | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listNarrationEngines } = require('@/data/repositories/narrationEngines') as typeof import('@/data/repositories/narrationEngines');
  const records = await listNarrationEngines();
  const candidates = MODEL_BUNDLES.filter((bundle) => bundle.engine === engine);
  for (const bundle of candidates) {
    const record = records.find((row) => row.id === bundle.id);
    if (!record) continue;
    if (record.status !== 'ready') continue;
    if (!record.modelDir) continue;
    if (record.verifiedAt === null) continue;
    return { bundle, modelDir: record.modelDir };
  }
  return null;
}

/** Default local probe: module load + a verified installed bundle. */
async function defaultLocalProbe(engine: LocalEngineKind): Promise<EngineAvailability> {
  const mod = loadSherpaModule();
  if (!mod) return { available: false, reason: 'not_installed' };
  try {
    const installed = await installedBundleFor(engine);
    if (!installed) return { available: false, reason: 'no_model' };
    return { available: true, detail: installed.bundle.label };
  } catch (error) {
    return { available: false, reason: 'no_model', detail: errorMessage(error) };
  }
}

function absoluteDocumentPath(relative: string): string {
  if (relative.startsWith('/')) return relative;
  const stripped = relative.replace(/^file:\/\//, '');
  if (stripped !== relative) return stripped;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Paths } = require('expo-file-system') as typeof import('expo-file-system');
    const root = String(Paths.document.uri ?? '').replace(/\/+$/, '');
    return (root ? `${root}/${relative}` : relative).replace(/^file:\/\//, '');
  } catch {
    return relative;
  }
}

/** Default local factory: resolve the installed bundle, then create the engine. */
async function defaultCreateLocalEngine(
  engine: LocalEngineKind,
): Promise<NarrationEngine | null> {
  const installed = await installedBundleFor(engine);
  if (!installed) return null;

  let speakerId: number | undefined;
  if (engine === 'kokoro') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { usePreferences } = require('@/state/preferences') as typeof import('@/state/preferences');
      const value = usePreferences.getState().narrationKokoroSpeaker;
      if (typeof value === 'number' && Number.isFinite(value)) speakerId = value;
    } catch {
      speakerId = undefined;
    }
  }

  return createLocalEngine(engine, {
    modelDir: absoluteDocumentPath(installed.modelDir),
    modelType: installed.bundle.modelType,
    numSpeakers: installed.bundle.speakers,
    speakerId,
    numThreads: 2,
  });
}

type ProbeSet = {
  device: EngineAvailability;
  remote: EngineAvailability;
  piper: EngineAvailability;
  kokoro: EngineAvailability;
};

let cache: ProbeSet | null = null;
let cacheDeps: NarrationEngineDeps | undefined;
let cacheIsDefault = false;

export function resetProbeCacheForTests(): void {
  cache = null;
  cacheDeps = undefined;
  cacheIsDefault = false;
}

/** Drop the session probe cache after a model install/delete. */
export function invalidateNarrationProbes(): void {
  cache = null;
  cacheDeps = undefined;
  cacheIsDefault = false;
}

/**
 * Probe every engine in parallel. Individual failures are contained, so this
 * never rejects; the result is memoised for the session.
 */
export async function probeNarrationEngines(
  deps: NarrationEngineDeps = {},
): Promise<ProbeSet> {
  const usingDefault = Object.keys(deps).length === 0;
  if (cache && (cacheDeps === deps || (usingDefault && cacheIsDefault))) return cache;

  const local = deps.probeLocal;
  const probeLocal = (engine: LocalEngineKind) =>
    local ?? (() => defaultLocalProbe(engine));
  const remote = deps.probeRemote ?? defaultRemoteAvailability;
  const device: EngineAvailability = { available: true };

  const [remoteResult, piper, kokoro] = await Promise.all([
    safeProbe(remote, 'no_key'),
    safeProbe(probeLocal('piper'), 'not_installed'),
    safeProbe(probeLocal('kokoro'), 'not_installed'),
  ]);

  const result: ProbeSet = {
    device,
    remote: remoteResult,
    piper,
    kokoro,
  };
  cache = result;
  cacheDeps = deps;
  cacheIsDefault = usingDefault;
  return result;
}

function reasonForUnavailable(
  preferred: RenditionEngine,
  availability: EngineAvailability,
): EngineUnavailableReason {
  if (!availability.available) return availability.reason;
  if (preferred === 'remote') return 'no_key';
  return 'model_absent';
}

/**
 * Deterministic: preferred when available, otherwise the device engine with the
 * matching reason. Never throws.
 */
export async function resolveNarrationEngine(
  preferred: RenditionEngine,
  deps: NarrationEngineDeps = {},
): Promise<{
  engine: NarrationEngine;
  degraded: boolean;
  reason?: EngineUnavailableReason;
}> {
  const probes = await probeNarrationEngines(deps);

  if (preferred === 'device') {
    return { engine: deviceEngine(), degraded: false };
  }

  const availability = probes[preferred];

  if (availability.available) {
    if (preferred === 'remote') {
      const config = await (deps.remoteConfig ?? defaultRemoteConfig)();
      const resolved = config && config.baseUrl && (config.apiKey || !getPreset(config.presetId ?? '').requiresKey)
        ? remoteEngine(config)
        : null;
      if (resolved) return { engine: resolved, degraded: false };
      return { engine: deviceEngine(), degraded: true, reason: 'no_key' };
    }

    try {
      const local = deps.createLocalEngine
        ? await deps.createLocalEngine(preferred)
        : await defaultCreateLocalEngine(preferred);
      if (local) return { engine: local, degraded: false };
      return {
        engine: deviceEngine(),
        degraded: true,
        reason: 'no_model',
      };
    } catch {
      return {
        engine: deviceEngine(),
        degraded: true,
        reason: 'load_failed',
      };
    }
  }

  return {
    engine: deviceEngine(),
    degraded: true,
    reason: reasonForUnavailable(preferred, availability),
  };
}

export function remoteEngineFromConfig(config: RemoteEngineConfig): NarrationEngine {
  return remoteEngine(config);
}
