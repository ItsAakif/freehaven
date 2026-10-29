/**
 * Speech synthesis providers.
 *
 * The device engine (expo-speech) needs no key and no network, but cannot hand
 * back an audio file. A remote OpenAI-compatible `/audio/speech` endpoint can,
 * which is what enables cached audio and lock-screen playback. Both sit behind
 * one interface so the Listen screen does not care which is active.
 */

import { Directory, File, Paths } from 'expo-file-system';

export type SpeechRequest = {
  text: string;
  /** Target language, e.g. en-US. */
  language: string;
  /** Provider voice identifier. */
  voice: string;
  model: string;
};

export type SpeechAsset = {
  uri: string;
  bytes: number;
  cached: boolean;
};

export interface SpeechCache {
  get(key: string): Promise<SpeechAsset | null>;
  put(key: string, bytes: Uint8Array): Promise<SpeechAsset>;
}

export interface SpeechSynthesisProvider {
  id: string;
  label: string;
  requiresKey: boolean;
  isAvailable(): Promise<boolean>;
  synthesize(request: SpeechRequest): Promise<SpeechAsset>;
}

/** Stable FNV-1a key over the request, so identical text/voice reuses the file. */
export function speechCacheKey(request: SpeechRequest): string {
  const input = `${request.model}|${request.voice}|${request.language}|${request.text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `narration-${hash.toString(16)}`;
}

export function fileSpeechCache(): SpeechCache {
  return {
    async get(key) {
      const file = new File(new Directory(Paths.cache, 'narration'), `${key}.mp3`);
      if (!file.exists) return null;
      return { uri: file.uri, bytes: file.size, cached: true };
    },
    async put(key, bytes) {
      const dir = new Directory(Paths.cache, 'narration');
      if (!dir.exists) dir.create({ intermediates: true });
      const file = new File(dir, `${key}.mp3`);
      if (file.exists) file.delete();
      file.create();
      await file.write(bytes);
      return { uri: file.uri, bytes: bytes.byteLength, cached: false };
    },
  };
}

export class RemoteSpeechProvider implements SpeechSynthesisProvider {
  readonly id = 'remote-speech';
  readonly label = 'Studio voice (remote)';
  readonly requiresKey = true;

  constructor(
    private options: {
      baseUrl: string;
      apiKey: string;
      fetchImpl?: typeof fetch;
      cache?: SpeechCache;
    },
  ) {}

  async isAvailable(): Promise<boolean> {
    return !!this.options.apiKey && !!this.options.baseUrl;
  }

  async synthesize(request: SpeechRequest): Promise<SpeechAsset> {
    if (!(await this.isAvailable())) throw new Error('No speech provider is configured.');
    const cache = this.options.cache ?? fileSpeechCache();
    const key = speechCacheKey(request);
    const hit = await cache.get(key);
    if (hit) return hit;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          voice: request.voice,
          input: request.text.slice(0, 4096),
          response_format: 'mp3',
        }),
      });
      if (!response.ok) throw new Error(`Speech endpoint returned ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error('The speech endpoint returned no audio.');
      return await cache.put(key, bytes);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('Speech synthesis timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Device voices exposed only for the settings picker; synthesis runs in expo-speech. */
export type DeviceVoice = { identifier: string; name: string; language: string; quality?: string };

export const NARRATION_LANGUAGES = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-ES', label: 'Español' },
  { id: 'fr-FR', label: 'Français' },
  { id: 'de-DE', label: 'Deutsch' },
  { id: 'pt-BR', label: 'Português (BR)' },
  { id: 'it-IT', label: 'Italiano' },
  { id: 'ja-JP', label: '日本語' },
] as const;

export function voicesForLanguage(voices: DeviceVoice[], language: string): DeviceVoice[] {
  const target = language.toLowerCase();
  const exact = voices.filter((voice) => voice.language.toLowerCase() === target);
  const pool = exact.length
    ? exact
    : voices.filter((voice) => voice.language.toLowerCase().startsWith(target.slice(0, 2)));
  return pool.sort((a, b) => a.name.localeCompare(b.name));
}
