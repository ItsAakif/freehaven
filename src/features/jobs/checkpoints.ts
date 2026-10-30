/**
 * Checkpoint key composition for generation jobs.
 *
 * Pure module. Two levels of hashing keep the stored key short while still
 * invalidating exactly one stage when its inputs change.
 */

import type { GenerationStage } from '@/domain/jobs';
import type { NarrationLength, RenditionEngine } from '@/domain/narration';
import { fnv1a32 } from '@/lib/hash';

/** Bump when the window planner changes meaning; invalidates script checkpoints. */
export const PLAN_VERSION = 1;
/** Bump when the segment planner changes meaning; invalidates synthesis checkpoints. */
export const SEGMENT_PLAN_VERSION = 1;

export function scriptStageKey(input: {
  bookId: string;
  documentId: string;
  styleId: string;
  length: NarrationLength;
  instructionHash: string;
  planVersion: number;
  providerId: string;
  model: string | null;
}): string {
  return fnv1a32(
    [
      'script',
      input.bookId,
      input.documentId,
      input.styleId,
      input.length,
      input.instructionHash,
      String(input.planVersion),
      input.providerId,
      input.model ?? '',
    ].join('|'),
  );
}

export function synthStageKey(input: {
  renditionId: string;
  engine: RenditionEngine;
  voice: string | null;
  model: string | null;
  instructionHash: string;
  segmentPlanVersion: number;
}): string {
  return fnv1a32(
    [
      'synth',
      input.renditionId,
      input.engine,
      input.voice ?? '',
      input.model ?? '',
      input.instructionHash,
      String(input.segmentPlanVersion),
    ].join('|'),
  );
}

export function unitInputKey(
  stageKey: string,
  stage: GenerationStage,
  ordinal: number,
  unitInput: string,
): string {
  return fnv1a32(`${stageKey}|${stage}|${ordinal}|${fnv1a32(unitInput)}`);
}
