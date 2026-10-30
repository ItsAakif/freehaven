/**
 * Pure ETA for generation jobs.
 *
 * No clock, no randomness, no React/Expo/SQLite imports. The caller passes
 * `now`; every output is a deterministic function of the input. The estimate is
 * always a range: false precision is worse than an honest span.
 */

import type { RenditionEngine } from '@/domain/narration';
import { JOB_LEASE_MS, type GenerationStage } from '@/domain/jobs';
import { ENGINE_SPREAD, STAGE_PRIOR_MS, SYNTH_PRIOR_MS } from './priors';

export type EtaStageState = { total: number; done: number };

export type EtaSample = {
  stage: GenerationStage;
  durationMs: number;
  /** When the unit finished. */
  at: number;
};

export type EtaPrevious = { at: number; remainingMs: number };

export type EtaInput = {
  now: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  order: readonly GenerationStage[];
  state: Partial<Record<GenerationStage, EtaStageState>>;
  currentStage: GenerationStage | null;
  /** ms spent in the in-flight unit, 0 when none. */
  inFlightElapsedMs: number;
  samples: readonly EtaSample[];
  engine: RenditionEngine;
  previous?: EtaPrevious | null;
};

export type EtaConfidence = 'none' | 'low' | 'medium' | 'high';

export type EtaOutput = {
  remainingMs: number | null;
  lowMs: number | null;
  highMs: number | null;
  confidence: EtaConfidence;
  unitsPerMin: number | null;
  elapsedMs: number;
  perUnitMs: Partial<Record<GenerationStage, number>>;
  stalled: boolean;
};

const MAX_WINDOW = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function priorFor(stage: GenerationStage, engine: RenditionEngine): number {
  return stage === 'synth' ? SYNTH_PRIOR_MS[engine] : STAGE_PRIOR_MS[stage];
}

function perUnit(
  stage: GenerationStage,
  samples: readonly EtaSample[],
  engine: RenditionEngine,
): { value: number; count: number } {
  const prior = priorFor(stage, engine);
  const window = samples.filter((sample) => sample.stage === stage).slice(-MAX_WINDOW);
  if (!window.length) return { value: prior, count: 0 };

  let mean = prior;
  let weight = 2;
  for (const sample of window) {
    mean = (mean * weight + sample.durationMs) / (weight + 1);
    weight = Math.min(weight + 0.5, 8);
  }
  return { value: mean, count: window.length };
}

function spreadRatio(samples: readonly EtaSample[]): number {
  const durations = samples.map((sample) => Math.max(0, sample.durationMs));
  if (durations.length < 2) return 0;
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  if (mean <= 0) return 0;
  const variance =
    durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length;
  return Math.sqrt(variance) / mean;
}

export function estimateEta(input: EtaInput): EtaOutput {
  const elapsedMs =
    input.startedAt === null ? 0 : Math.max(0, input.now - input.startedAt);

  const perUnitMs: Partial<Record<GenerationStage, number>> = {};
  let sampleCount = 0;
  let unitsTotal = 0;
  let unitsDone = 0;

  for (const stage of input.order) {
    const stageState = input.state[stage];
    const measured = perUnit(stage, input.samples, input.engine);
    perUnitMs[stage] = measured.value;
    sampleCount += measured.count;
    unitsTotal += Math.max(0, stageState?.total ?? 0);
    unitsDone += Math.max(0, stageState?.done ?? 0);
  }

  const stalled =
    input.heartbeatAt !== null && input.now - input.heartbeatAt > JOB_LEASE_MS;

  const base: Omit<EtaOutput, 'remainingMs' | 'lowMs' | 'highMs' | 'confidence'> = {
    unitsPerMin: null,
    elapsedMs,
    perUnitMs,
    stalled,
  };

  if (!unitsTotal) {
    return { ...base, remainingMs: null, lowMs: null, highMs: null, confidence: 'none' };
  }

  const usedSamples = input.order.flatMap((stage) =>
    input.samples.filter((sample) => sample.stage === stage).slice(-MAX_WINDOW),
  );

  const recent = input.samples.filter((sample) => sample.at >= input.now - 180_000);
  let unitsPerMin: number | null = null;
  if (recent.length) {
    const oldest = Math.min(...recent.map((sample) => sample.at));
    unitsPerMin = recent.length / Math.max(1 / 60, (input.now - oldest) / 60_000);
  } else {
    const fallback = input.currentStage
      ? perUnitMs[input.currentStage]
      : input.order.length
        ? perUnitMs[input.order[0]]
        : 0;
    unitsPerMin = fallback && fallback > 0 ? 60_000 / fallback : null;
  }

  let remaining = 0;
  for (const stage of input.order) {
    const stageState = input.state[stage];
    const total = Math.max(0, stageState?.total ?? 0);
    const done = Math.max(0, stageState?.done ?? 0);
    if (!total || done >= total) continue;

    let unitsLeft = total - done;
    if (stage === input.currentStage && input.inFlightElapsedMs > 0) {
      const unitMs = perUnitMs[stage] ?? 0;
      if (unitMs > 0) {
        const fraction = clamp(1 - input.inFlightElapsedMs / unitMs, 0.05, 1);
        unitsLeft = Math.max(0, unitsLeft - 1 + fraction);
      }
    }
    remaining += unitsLeft * (perUnitMs[stage] ?? 0);
  }

  const complete = input.order.every((stage) => {
    const stageState = input.state[stage];
    const total = stageState?.total ?? 0;
    return total === 0 || (stageState?.done ?? 0) >= total;
  });

  if (complete) {
    return {
      ...base,
      unitsPerMin,
      remainingMs: 0,
      lowMs: 0,
      highMs: 0,
      confidence: 'high',
    };
  }

  const cv = spreadRatio(usedSamples);
  const rel = clamp(
    0.55 / Math.sqrt(1 + sampleCount) + 0.6 * cv + 0.5 * ENGINE_SPREAD[input.engine],
    0.1,
    1.2,
  );

  if (input.previous && input.startedAt !== null) {
    const prevImplied =
      Math.max(0, input.previous.at - input.startedAt) + Math.max(0, input.previous.remainingMs);
    const minRemaining = Math.max(0, prevImplied * 0.8 - elapsedMs);
    if (remaining < minRemaining) remaining = minRemaining;
  }

  let confidence: EtaConfidence;
  if (unitsDone === 0 && sampleCount === 0) confidence = 'low';
  else if (sampleCount < 2) confidence = 'low';
  else if (sampleCount < 5) confidence = 'medium';
  else confidence = 'high';

  return {
    ...base,
    unitsPerMin,
    remainingMs: Math.round(remaining),
    lowMs: Math.round(remaining * (1 - rel)),
    highMs: Math.round(remaining * (1 + rel)),
    confidence,
  };
}

function roundStep(minutes: number): number {
  if (minutes < 10) return 1;
  if (minutes < 60) return 5;
  return 10;
}

function roundDown(minutes: number, step: number): number {
  return Math.max(0, Math.floor(minutes / step) * step);
}

function roundUp(minutes: number, step: number): number {
  return Math.max(0, Math.ceil(minutes / step) * step);
}

/**
 * Never a point estimate: the short line is always a range. The detail line
 * carries the confidence caveat, not another number.
 */
export function formatEtaRange(input: {
  remainingMs: number | null;
  lowMs: number | null;
  highMs: number | null;
  confidence: EtaConfidence;
}): { short: string; detail: string } {
  const rough = input.confidence === 'low' ? 'Rough estimate. ' : '';

  if (input.remainingMs === null) {
    return {
      short: 'Estimating…',
      detail: 'The first passage has not finished yet.',
    };
  }

  if (input.remainingMs < 60_000) {
    return {
      short: 'Less than a minute left',
      detail: `${rough}The last steps are finishing.`,
    };
  }

  const lowMs = input.lowMs ?? input.remainingMs;
  const highMs = input.highMs ?? input.remainingMs;
  const step = roundStep(Math.max(1, input.remainingMs / 60_000));
  const lowMinutes = roundDown(Math.max(0, lowMs) / 60_000, step);
  const highMinutes = roundUp(Math.max(0, highMs) / 60_000, step);
  const safeHigh = Math.max(lowMinutes, highMinutes);
  const detail = `${rough}Times are a range because model calls vary. The estimate tightens after the first few passages.`;

  if (safeHigh >= 60) {
    const lowHours = Math.max(1, Math.floor(lowMinutes / 60));
    const highHours = Math.max(lowHours, Math.ceil(safeHigh / 60));
    return { short: `About ${lowHours}–${highHours} hr left`, detail };
  }

  return { short: `About ${lowMinutes}–${safeHigh} min left`, detail };
}
