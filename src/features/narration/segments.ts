/**
 * Speech segmentation.
 *
 * Pure: split the exact script text into playable pieces without changing it.
 * Concatenating the returned text reproduces the input except for collapsed
 * whitespace at piece boundaries.
 */

import type { RenditionEngine } from '../../domain/narration';
import { splitSentences } from '../../domain/text';

const ENGINE_MAX_CHARS: Record<RenditionEngine, number> = {
  device: 480,
  remote: 3_800,
  piper: 800,
  kokoro: 600,
};

export function maxCharsForEngine(engine: RenditionEngine): number {
  return ENGINE_MAX_CHARS[engine] ?? 480;
}

export type SpeechSegmentPiece = {
  text: string;
  charStart: number;
  charEnd: number;
};

/**
 * Split on sentence boundaries; a sentence longer than `maxChars` is hard-split
 * at the last space before the limit (or exactly at the limit when there is no
 * space). Never returns an empty piece and preserves source order.
 */
export function planSpeechSegments(text: string, maxChars: number): SpeechSegmentPiece[] {
  const limit = Math.max(1, Math.floor(maxChars) || 1);
  const sentences = splitSentences(text);
  if (!sentences.length) return [];

  const pieces: SpeechSegmentPiece[] = [];
  let cursor = 0;
  let buffer = '';
  let bufferStart = 0;

  const flush = () => {
    if (!buffer) return;
    pieces.push({ text: buffer, charStart: bufferStart, charEnd: bufferStart + buffer.length });
    buffer = '';
  };

  const push = (value: string) => {
    if (!value) return;
    pieces.push({ text: value, charStart: cursor, charEnd: cursor + value.length });
    cursor += value.length + 1;
  };

  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > limit) {
      flush();
      let cut = rest.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      const head = rest.slice(0, cut).trim();
      push(head);
      rest = rest.slice(cut).trim();
    }
    if (!rest) continue;
    if (buffer && buffer.length + 1 + rest.length > limit) flush();
    if (!buffer) bufferStart = cursor;
    buffer = buffer ? `${buffer} ${rest}` : rest;
    cursor += rest.length + 1;
  }
  flush();

  return pieces;
}
