/**
 * Pure read-along helpers. The listen screen renders a segment token by token;
 * a word index is derived from playback progress, so no timer state is needed
 * in the pure layer and every case is unit-testable.
 */

import type { SpeechTiming } from '@/domain/narration';

export type TranscriptToken = {
  /** Whitespace or a word exactly as it appears in the segment text. */
  text: string;
  /** True for a non-whitespace run, false for the whitespace between words. */
  word: boolean;
};

/** Split text into word and whitespace tokens, preserving the original spacing. */
export function tokenizeTranscript(text: string): TranscriptToken[] {
  const tokens = text.match(/\s+|\S+/g) ?? [];
  return tokens.map((token) => ({ text: token, word: token.trim().length > 0 }));
}

/** Number of word tokens in a segment. */
export function transcriptWordCount(text: string): number {
  return tokenizeTranscript(text).reduce((count, token) => count + (token.word ? 1 : 0), 0);
}

/**
 * Map playback progress (0..1, clamped) onto the index of the active word.
 * Empty text returns -1 so callers can skip the highlight entirely.
 */
export function wordIndexForProgress(text: string, progress: number): number {
  const count = transcriptWordCount(text);
  if (count === 0) return -1;
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return Math.min(count - 1, Math.floor(clamped * count));
}

/**
 * Progress inside one segment from an absolute position. Missing durations use
 * the same character estimate as the manifest, matching device narration.
 */
export function segmentProgress(
  positionMs: number,
  segmentStartMs: number,
  durationMs: number | null,
  text: string,
  estimateDurationMs: (value: string) => number,
): number {
  const duration = durationMs && durationMs > 0 ? durationMs : estimateDurationMs(text);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const elapsed = Math.max(0, positionMs - segmentStartMs);
  return Math.min(1, elapsed / duration);
}

function isSpeechTiming(value: unknown): value is SpeechTiming {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    typeof candidate.startMs === 'number' &&
    Number.isFinite(candidate.startMs) &&
    typeof candidate.endMs === 'number' &&
    Number.isFinite(candidate.endMs)
  );
}

/** Parse a stored `timings_json` value; garbage or empty falls back to []. */
export function parseSpeechTimings(value: string | null | undefined): SpeechTiming[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSpeechTiming);
  } catch {
    return [];
  }
}

/**
 * Index of the token being spoken at `elapsedMs` inside a segment.
 *
 * Before the first token the first word stays highlighted; a gap between tokens
 * keeps the previous token active; after the last token the last stays active.
 * Empty timings return -1 so callers can use the progress fallback.
 */
export function timingIndexForElapsed(
  timings: SpeechTiming[],
  elapsedMs: number,
): number {
  if (!timings.length) return -1;
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  for (let index = timings.length - 1; index >= 0; index -= 1) {
    if (elapsed >= timings[index].startMs) return index;
  }
  return 0;
}
