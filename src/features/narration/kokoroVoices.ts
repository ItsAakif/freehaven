/**
 * Kokoro multi-language speaker names.
 *
 * The bundle advertises 103 speaker indices, but only the first 28 are the
 * documented English voices. Unknown indices keep a neutral "Voice N" label so
 * the settings stepper works with any installed bundle.
 */

export const KOKORO_VOICE_NAMES: readonly string[] = [
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_heart',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
] as const;

/** Human-readable name for a Kokoro speaker index. */
export function kokoroVoiceName(index: number): string {
  if (!Number.isInteger(index) || index < 0) return `Voice ${index}`;
  return KOKORO_VOICE_NAMES[index] ?? `Voice ${index}`;
}
