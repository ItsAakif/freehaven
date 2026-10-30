/**
 * Compatibility shim for the old provider API.
 *
 * Contract D rewrites the Listen screen. Until then this returns the resolved
 * `NarrationEngine` plus a legacy `synthesize` adapter so `download.ts` and the
 * old screen keep working without knowing about the engine layer.
 */

import type { NarrationStyleId } from '@/domain/narration';
import { usePreferences } from '@/state/preferences';
import { getNarrationStyle } from '@/features/narration/styles';
import { instructionHash } from '@/features/narration/script';
import {
  resolveNarrationEngine,
  type EngineUnavailableReason,
  type NarrationEngine,
} from '@/features/narration/engines';
import type { SpeechAsset } from './providers';

export * from './providers';

export type LegacySpeechRequest = {
  text: string;
  language: string;
  voice: string;
  model: string;
  style?: NarrationStyleId;
};

export type ResolvedSpeechProvider = {
  engine: NarrationEngine;
  degraded: boolean;
  reason?: EngineUnavailableReason;
  synthesize(request: LegacySpeechRequest): Promise<SpeechAsset>;
};

/** @deprecated Use `resolveNarrationEngine`. */
export async function resolveSpeechProvider(): Promise<ResolvedSpeechProvider> {
  const prefs = usePreferences.getState();
  const preferred =
    prefs.narrationEngine ?? (prefs.studioVoice ? 'remote' : 'device');

  const resolved = await resolveNarrationEngine(preferred);
  const style = getNarrationStyle(
    typeof prefs.narrationStyle === 'string' ? prefs.narrationStyle : undefined,
  );

  return {
    ...resolved,
    async synthesize(request: LegacySpeechRequest): Promise<SpeechAsset> {
      const requestStyle = getNarrationStyle(request.style ?? style.id);
      return resolved.engine.synthesize({
        text: request.text,
        language: request.language,
        voice: request.voice,
        model: request.model,
        engine: resolved.engine.id,
        styleId: requestStyle.id,
        instructions: requestStyle.directive,
        instructionHash: instructionHash(''),
        format: resolved.engine.id === 'remote' ? 'mp3' : 'wav',
      });
    },
  };
}
