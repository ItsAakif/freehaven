/**
 * Pure preferences migration.
 *
 * Kept separate from the Zustand store so Jest can import and exercise it
 * without touching Expo's kv-store. Never throws, never drops unknown keys.
 */

import { coerceNarrationStyle } from '@/features/narration/styles';
import type { NarrationLength, NarrationStyleId, RenditionEngine } from '@/domain/narration';
import type { PreferencesState } from '@/state/preferences';
import { inferPresetId } from '@/ai/presets';

type AiResponseFormat = 'auto' | 'json_schema' | 'json_object' | 'none';

export type MigratedPreferences = Partial<PreferencesState> & {
  aiPreset: string;
  aiResponseFormat: AiResponseFormat;
  narrationStyle: NarrationStyleId;
  narrationLength: NarrationLength;
  narrationEngine: RenditionEngine;
  narrationInstruction: string;
};

const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
const RESPONSE_FORMATS: readonly AiResponseFormat[] = [
  'auto',
  'json_schema',
  'json_object',
  'none',
];
const LENGTHS: readonly NarrationLength[] = ['5', '15', '25'];
const ENGINES: readonly RenditionEngine[] = ['device', 'remote', 'piper', 'kokoro'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Bring any persisted shape up to version 2.
 *
 * `fromVersion` is accepted for Zustand's migrate signature; the rules below are
 * deliberately idempotent so re-running the migration is safe.
 */
export function migratePreferences(persisted: unknown, fromVersion: number): MigratedPreferences {
  void fromVersion;
  const source = isRecord(persisted) ? persisted : {};

  const aiBaseUrl =
    typeof source.aiBaseUrl === 'string' && source.aiBaseUrl.trim()
      ? source.aiBaseUrl
      : DEFAULT_AI_BASE_URL;

  const aiPreset =
    typeof source.aiPreset === 'string' && source.aiPreset.trim()
      ? source.aiPreset
      : inferPresetId(aiBaseUrl);

  const narrationStyle = coerceNarrationStyle(source.narrationStyle);

  const narrationEngine: RenditionEngine =
    source.studioVoice === true
      ? 'remote'
      : isOneOf(source.narrationEngine, ENGINES)
        ? source.narrationEngine
        : 'device';

  return {
    // Unknown keys survive the migration untouched.
    ...source,
    aiPreset,
    aiResponseFormat: isOneOf(source.aiResponseFormat, RESPONSE_FORMATS)
      ? source.aiResponseFormat
      : 'auto',
    narrationStyle,
    narrationLength: isOneOf(source.narrationLength, LENGTHS) ? source.narrationLength : '15',
    narrationEngine,
    narrationInstruction:
      typeof source.narrationInstruction === 'string' ? source.narrationInstruction : '',
    // Keep the legacy convenience field consistent with the engine.
    studioVoice: narrationEngine === 'remote',
  };
}
