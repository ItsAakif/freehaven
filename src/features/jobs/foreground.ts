/**
 * Background generation bridge.
 *
 * Thin, injectable seam between the pure job runner and the local Android Expo
 * module. The default implementation lazily imports the module, so importing
 * the runner on web, iOS, Expo Go or in Jest never touches native code. Every
 * call is best-effort: the OS is allowed to refuse a foreground service, and
 * that must never fail a generation job.
 */

import type { GenerationStage } from '@/domain/jobs';
import { formatEtaRange, type EtaConfidence } from './eta';

export type ForegroundGenerationBridge = {
  start(input: { title: string; text: string }): Promise<void>;
  update(input: { text: string; progress: number }): Promise<void>;
  stop(): Promise<void>;
};

type LocalBackgroundGenerationModule = {
  isBackgroundGenerationSupported(): boolean;
  startBackgroundGeneration(input: { title: string; text: string }): Promise<void>;
  updateBackgroundGeneration(input: { text: string; progress: number }): Promise<void>;
  stopBackgroundGeneration(): Promise<void>;
};

/** Minimum gap between progress notifications unless the stage changes. */
export const FOREGROUND_UPDATE_INTERVAL_MS = 5_000;

const STAGE_LABELS: Record<GenerationStage, string> = {
  map: 'Reading passages',
  merge: 'Condensing notes',
  reduce: 'Shaping the outline',
  expand: 'Writing the script',
  synth: 'Recording audio',
};

export type ForegroundEta = {
  remainingMs: number | null;
  lowMs: number | null;
  highMs: number | null;
  confidence: EtaConfidence;
};

let override: ForegroundGenerationBridge | null = null;
let modulePromise: Promise<LocalBackgroundGenerationModule | null> | null = null;

async function loadModule(): Promise<LocalBackgroundGenerationModule | null> {
  if (!modulePromise) {
    modulePromise = import('../../../modules/background-generation')
      .then((loaded) => {
        const candidate = loaded as LocalBackgroundGenerationModule;
        return candidate.isBackgroundGenerationSupported() ? candidate : null;
      })
      .catch(() => null);
  }
  return modulePromise;
}

const defaultBridge: ForegroundGenerationBridge = {
  async start(input) {
    const module = await loadModule();
    await module?.startBackgroundGeneration(input);
  },
  async update(input) {
    const module = await loadModule();
    await module?.updateBackgroundGeneration(input);
  },
  async stop() {
    const module = await loadModule();
    await module?.stopBackgroundGeneration();
  },
};

/** The bridge the runner should use right now (test override or default). */
export function getForegroundBridge(): ForegroundGenerationBridge {
  return override ?? defaultBridge;
}

/**
 * Test seam. Pass `null` to restore the real, lazy local-module bridge.
 * Returning void keeps accidental production use harmless.
 */
export function setForegroundBridgeForTests(bridge: ForegroundGenerationBridge | null): void {
  override = bridge;
}

export function foregroundStageLabel(stage: GenerationStage | null): string {
  return stage ? STAGE_LABELS[stage] : 'Preparing';
}

/** Human-readable notification text: stage plus the honest ETA range. */
export function foregroundProgressText(input: {
  stage: GenerationStage | null;
  eta: ForegroundEta;
}): string {
  return `${foregroundStageLabel(input.stage)} - ${formatEtaRange(input.eta).short}`;
}
