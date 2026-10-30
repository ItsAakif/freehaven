/**
 * ETA priors.
 *
 * These are guesses from the stated device measurements, not promises:
 * Kokoro 15–40 min, Piper 4–7 min, remote 1.5–3 min for a 15-minute lesson.
 * After two samples the measured EWMA dominates.
 */

import type { RenditionEngine } from '@/domain/narration';
import type { GenerationStage } from '@/domain/jobs';

export const STAGE_PRIOR_MS: Record<GenerationStage, number> = {
  map: 6_500,
  merge: 3_500,
  reduce: 5_000,
  expand: 24_000,
  synth: 0,
};

export const SYNTH_PRIOR_MS: Record<RenditionEngine, number> = {
  device: 60,
  remote: 5_500,
  piper: 14_000,
  kokoro: 60_000,
};

export const ENGINE_SPREAD: Record<RenditionEngine, number> = {
  device: 0.1,
  remote: 0.5,
  piper: 0.35,
  kokoro: 0.8,
};
