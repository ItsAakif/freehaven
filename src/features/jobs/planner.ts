/**
 * Job planning and hash composition.
 *
 * Pure helpers: the runner supplies the rendition/document rows. Hashes are
 * deliberately split so a script edit never redoes audio unless the audio
 * inputs (engine/voice/instruction) also changed.
 */

import type { GenerationStage, JobRecord } from '@/domain/jobs';
import type { Rendition } from '@/domain/narration';
import type { TierPlan } from '@/features/learning/windows';
import { wordsForMinutes } from '@/features/narration/lengths';
import { instructionHash } from '@/features/narration/script';
import { SEGMENT_PLAN_VERSION, PLAN_VERSION } from './checkpoints';

const MAX_BATCH_CHARS = 12_000;

/** Approximate per-stage unit counts for the initial progress denominator. */
export function planScriptUnits(input: {
  chars: number;
  windows: number;
  tiers: TierPlan;
  targetWords: number;
}): { unitsTotal: number; perStage: Record<GenerationStage, number> } {
  const map =
    input.tiers.levels > 0
      ? Math.max(0, Math.round(input.tiers.units0))
      : Math.max(0, Math.round(input.windows || input.tiers.units0 || 0));
  const merge = input.tiers.levels > 0 ? Math.max(0, Math.round(input.tiers.totalMergeUnits)) : 0;
  const reduce =
    input.tiers.levels > 0
      ? 2
      : Math.max(1, Math.ceil(Math.max(1, input.chars) / MAX_BATCH_CHARS));
  const expand = Math.min(5, Math.max(3, Math.ceil(Math.max(1, input.targetWords) / 800)));
  const synth = 0;

  const perStage: Record<GenerationStage, number> = {
    map,
    merge,
    reduce,
    expand,
    synth,
  };
  return {
    unitsTotal: map + merge + reduce + expand + synth,
    perStage,
  };
}

function instructionFor(rendition: Rendition): string {
  return rendition.instructionHash ?? instructionHash(rendition.instruction ?? '');
}

/** Script checkpoints are engine-independent; model/provider changes invalidate them. */
export function scriptHashFor(
  rendition: Rendition,
  documentId: string,
  providerId: string,
  model: string | null,
): string {
  return [
    rendition.bookId,
    documentId,
    rendition.styleId,
    rendition.length,
    instructionFor(rendition),
    String(wordsForMinutes(rendition.length)),
    String(PLAN_VERSION),
    providerId,
    model ?? '',
  ].join('|');
}

/** Synthesis checkpoints are engine/voice/model dependent, never style-dependent. */
export function synthHashFor(rendition: Rendition): string {
  return [
    rendition.id,
    rendition.engine,
    rendition.voice ?? '',
    rendition.model ?? '',
    instructionFor(rendition),
    String(SEGMENT_PLAN_VERSION),
  ].join('|');
}

export function needsScriptCheckpointReset(active: JobRecord, nextScriptHash: string): boolean {
  return active.scriptHash !== nextScriptHash;
}

export function needsSynthCheckpointReset(active: JobRecord, nextSynthHash: string): boolean {
  return active.synthHash !== nextSynthHash;
}

const MAX_WINDOWS = 18;

/** Windows estimate used before chunks are loaded; the runner refines on progress. */
export function estimateWindows(chars: number): number {
  if (chars <= 0) return 0;
  return Math.min(MAX_WINDOWS, Math.max(1, Math.ceil(chars / 14_000)));
}
