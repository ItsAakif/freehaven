/**
 * Speech cache key v2.
 *
 * Pure module: no Expo, no network. The key deliberately includes every input
 * that changes the produced bytes so two styles, engines or endpoints can never
 * overwrite each other's audio.
 */

import type { NarrationStyleId, RenditionEngine } from '@/domain/narration';

export type SpeechFormat = 'mp3' | 'wav';

export type SpeechRequest = {
  text: string;
  language: string;
  voice: string;
  model: string;
  engine: RenditionEngine;
  styleId: NarrationStyleId;
  /** Composed style directive. Sent only when the target model accepts `instructions`. */
  instructions?: string;
  /** '' when no instruction; part of the cache key. */
  instructionHash: string;
  /** Remote only; part of the cache key so two endpoints never share files. */
  baseUrl?: string;
  format: SpeechFormat;
  /** When set, write the file here (rendition segments). Otherwise use the shared cache dir. */
  destPath?: string;
  /** Sherpa only. */
  speakerId?: number;
  /** Sherpa only; 1 = normal. Device and remote ignore it. */
  speed?: number;
};

/** FNV-1a 32-bit over a UTF-16 string. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Host-only form of a base URL so path and query changes do not fragment the cache. */
function hostOnly(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * `narr2-<h1><h2>`: two independent FNV-1a passes give 64 bits with no new
 * dependency. Any change to an input changes the key; never reuse `narration-`.
 */
export function speechCacheKey(request: SpeechRequest): string {
  const input = [
    request.engine,
    hostOnly(request.baseUrl),
    request.model,
    request.voice,
    request.language,
    request.format,
    request.styleId,
    request.instructionHash,
    request.speakerId ?? '',
    request.speed ?? '',
    'v2',
    request.text,
  ].join('|');

  const h1 = fnv1a(input, 0x811c9dc5).toString(16).padStart(8, '0');
  const h2 = fnv1a(input, 0x01000193).toString(16).padStart(8, '0');
  return `narr2-${h1}${h2}`;
}
