/**
 * Narration length presets and word budgets.
 *
 * Created with the styles so Contracts B and D can import it before the rest of
 * the narration work lands. Pure: no Expo, no clocks.
 */

import type { NarrationLength } from '@/domain/narration';

export interface LengthPreset {
  id: NarrationLength;
  label: string;
  minutes: number;
  words: number;
}

export const LENGTH_PRESETS: readonly LengthPreset[] = [
  { id: '5', label: '5 minutes', minutes: 5, words: 725 },
  { id: '15', label: '15 minutes', minutes: 15, words: 2175 },
  { id: '25', label: '25 minutes', minutes: 25, words: 3625 },
] as const;

const WORDS_BY_MINUTES: Record<NarrationLength, number> = {
  '5': 725,
  '15': 2175,
  '25': 3625,
};

/** Target words for a length preset (145 words/minute, clear TTS delivery). */
export function wordsForMinutes(minutes: NarrationLength): number {
  return WORDS_BY_MINUTES[minutes];
}

/** Estimated spoken duration for a word count; progress UI only, never offsets. */
export function estimateSpokenMs(words: number, wpm = 145): number {
  if (!Number.isFinite(words) || words <= 0) return 0;
  return Math.round((words / Math.max(1, wpm)) * 60_000);
}
