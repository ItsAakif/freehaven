/**
 * Pre-flight estimate for a Full Guide.
 *
 * Deterministic: no clock, randomness or I/O. Priors come from the existing
 * planner/priors modules rather than a new guide-specific table.
 */

import type { RenditionEngine } from '@/domain/narration';
import { ENGINE_SPREAD, SYNTH_PRIOR_MS } from '@/features/jobs/priors';
import { estimateWindows, planScriptUnits } from '@/features/jobs/planner';
import { WORDS_PER_MINUTE } from '@/features/learning/summarise';
import { planTiers } from '@/features/learning/windows';
import { maxCharsForEngine } from '@/features/narration/segments';
import { GUIDE_SCRIPT_CALL_MS } from './constants';

export type GuideEstimate = {
  chapters: number;
  words: number;
  audioMinutes: number;
  modelCalls: number;
  segments: number;
  scriptLowMs: number;
  scriptHighMs: number;
  synthLowMs: number;
  synthHighMs: number;
  synthPriorMs: number;
};

const ENGINE_LABEL: Record<RenditionEngine, string> = {
  device: 'Device',
  remote: 'Remote',
  piper: 'Piper',
  kokoro: 'Kokoro',
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function estimateChapterCount(input: {
  format: 'epub' | 'pdf' | 'text';
  pageCount: number | null;
  sectionCount: number;
}): number {
  if (input.format === 'pdf') {
    return clamp(Math.round((input.pageCount ?? input.sectionCount) / 12), 3, 40);
  }
  return Math.max(1, input.sectionCount);
}

export function estimateGuideBuild(input: {
  chapters: number;
  wordsPerChapter: number;
  engine: RenditionEngine;
}): GuideEstimate {
  const chapters = Math.max(0, Math.round(input.chapters));
  const wordsPerChapter = Math.max(1, Math.round(input.wordsPerChapter));
  const words = chapters * wordsPerChapter;
  const audioMinutes = Math.round((words / WORDS_PER_MINUTE) * 10) / 10;

  const perChapterChars = wordsPerChapter * 6;
  const perChapterPlan = planScriptUnits({
    chars: perChapterChars,
    windows: estimateWindows(perChapterChars),
    tiers: planTiers(perChapterChars),
    targetWords: wordsPerChapter,
  });
  const modelCalls = chapters * perChapterPlan.unitsTotal;

  const scriptLowMs = Math.round(modelCalls * GUIDE_SCRIPT_CALL_MS * 0.6);
  const scriptHighMs = Math.round(modelCalls * GUIDE_SCRIPT_CALL_MS * 1.8);

  const segmentsPerChapter = Math.max(
    1,
    Math.ceil(perChapterChars / maxCharsForEngine(input.engine)),
  );
  const segments = chapters * segmentsPerChapter;
  const synthPriorMs = Math.round(segments * SYNTH_PRIOR_MS[input.engine]);
  const synthLowMs = Math.round(synthPriorMs * (1 - ENGINE_SPREAD[input.engine]));
  const synthHighMs = Math.round(synthPriorMs * (1 + ENGINE_SPREAD[input.engine]));

  return {
    chapters,
    words,
    audioMinutes,
    modelCalls,
    segments,
    scriptLowMs,
    scriptHighMs,
    synthLowMs,
    synthHighMs,
    synthPriorMs,
  };
}

function scriptRange(estimate: GuideEstimate): { low: number; high: number } {
  const low = Math.floor(estimate.scriptLowMs / 60_000 / 5) * 5;
  const high = Math.ceil(estimate.scriptHighMs / 60_000 / 5) * 5;
  return { low, high };
}

function synthCopy(estimate: GuideEstimate, engine: RenditionEngine): string {
  if (engine === 'device' || estimate.synthHighMs < 10_000) return 'instant';
  const highMinutes = Math.max(1, Math.round(estimate.synthHighMs / 60_000));
  if (highMinutes >= 60) {
    const lowHours = Math.max(1, Math.round(estimate.synthLowMs / 3_600_000));
    const highHours = Math.max(1, Math.round(estimate.synthHighMs / 3_600_000));
    return `about ${lowHours}–${highHours} hr`;
  }
  const lowMinutes = Math.max(1, Math.round(estimate.synthLowMs / 60_000));
  return `about ${lowMinutes}–${highMinutes} min`;
}

export function estimateGuideCopy(
  estimate: GuideEstimate,
  engine: RenditionEngine,
): { short: string; detail: string } {
  const short = `${estimate.chapters} chapters · ${estimate.words.toLocaleString(
    'en-US',
  )} words · ~${Math.round(estimate.audioMinutes)} min of audio`;
  const range = scriptRange(estimate);
  const detail = `About ${range.low}–${range.high} min to write, then ${synthCopy(
    estimate,
    engine,
  )} for ${ENGINE_LABEL[engine]} audio.`;
  return { short, detail };
}
