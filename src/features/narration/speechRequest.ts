/**
 * Shared speech-request composition.
 *
 * One source of truth for rendition and guide synthesis: the same request
 * object produces the same `speechCacheKey`, so planning and synthesis can
 * never disagree about a segment's file.
 */

import type { NarrationStyleId, RenditionEngine } from '@/domain/narration';
import type { SpeechFormat, SpeechRequest } from './cacheKey';
import { getNarrationStyle } from './styles';

export const DEFAULT_REMOTE_MODEL = 'tts-1';

export function engineFormat(engine: RenditionEngine): SpeechFormat {
  return engine === 'remote' ? 'mp3' : 'wav';
}

/** Effective voice: explicit choice, then the style default, then a safe label. */
export function effectiveVoice(
  styleId: NarrationStyleId | string,
  engine: RenditionEngine,
  voice: string | null,
): string {
  if (voice) return voice;
  const style = getNarrationStyle(styleId);
  return style.defaultVoices[engine] ?? 'default';
}

/** Effective model: explicit choice, then the engine's natural model id. */
export function effectiveModel(engine: RenditionEngine, model: string | null): string {
  if (model) return model;
  return engine === 'remote' ? DEFAULT_REMOTE_MODEL : engine;
}

/**
 * Lazy preference read; only remote synthesis needs the endpoint. Kept here
 * (with the same lazy `require`) so both narration and guides hash identically.
 */
export function remoteBaseUrl(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { usePreferences } = require('@/state/preferences') as typeof import('@/state/preferences');
    const url = usePreferences.getState().aiBaseUrl;
    return url ? String(url) : undefined;
  } catch {
    return undefined;
  }
}

export function buildSpeechRequest(input: {
  engine: RenditionEngine;
  styleId: NarrationStyleId;
  language: string;
  voice: string | null;
  model: string | null;
  instruction: string | null;
  instructionHash: string;
  text: string;
  format: SpeechFormat;
  baseUrl?: string;
  destPath?: string;
  speakerId?: number;
  speed?: number;
}): SpeechRequest {
  const style = getNarrationStyle(input.styleId);
  return {
    text: input.text,
    language: input.language,
    voice: effectiveVoice(style.id, input.engine, input.voice),
    model: effectiveModel(input.engine, input.model),
    engine: input.engine,
    styleId: style.id,
    instructions: style.directive,
    instructionHash: input.instructionHash,
    baseUrl: input.engine === 'remote' ? input.baseUrl : undefined,
    format: input.format,
    destPath: input.engine === 'device' ? undefined : input.destPath,
    speakerId: input.engine === 'kokoro' ? style.kokoroSpeakerId : undefined,
    speed: input.speed ?? 1,
  };
}
