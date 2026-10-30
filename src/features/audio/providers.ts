/**
 * Speech synthesis providers.
 *
 * The device engine (expo-speech) needs no key and no network, but cannot hand
 * back an audio file. A remote OpenAI-compatible `/audio/speech` endpoint can,
 * which is what enables cached audio and lock-screen playback. Both sit behind
 * one interface so the Listen screen does not care which is active.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { getPreset } from '@/ai/presets';
import { speechCacheKey } from '@/features/narration/cacheKey';
import type { SpeechFormat, SpeechRequest } from '@/features/narration/cacheKey';

export { speechCacheKey };
export type { SpeechFormat, SpeechRequest };

/** Thrown when an engine is deliberately unable to produce a file (device voice). */
export class UnsupportedOperationError extends Error {
  constructor(message = 'This engine cannot produce audio files.') {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

/** Only the gpt-4o TTS family accepts delivery instructions today. */
export function supportsInstructions(model: string): boolean {
  return model.includes('gpt-4o');
}

export type SpeechAsset = {
  uri: string;
  bytes: number;
  cached: boolean;
  format: SpeechFormat;
};

export interface SpeechCache {
  get(key: string, format?: SpeechFormat): Promise<SpeechAsset | null>;
  put(key: string, bytes: Uint8Array, format?: SpeechFormat): Promise<SpeechAsset>;
  /** Optional: write straight to a rendition segment path instead of the shared cache. */
  putAt?(destPath: string, bytes: Uint8Array, format: SpeechFormat): Promise<SpeechAsset>;
}

export interface SpeechSynthesisProvider {
  id: string;
  label: string;
  requiresKey: boolean;
  /** False for the device engine: it never produces a file. */
  producesFiles?: boolean;
  isAvailable(): Promise<boolean>;
  synthesize(request: SpeechRequest): Promise<SpeechAsset>;
}

function narrationDirectory(): Directory {
  return new Directory(Paths.cache, 'narration');
}

function ensureDirectory(dir: Directory): void {
  if (!dir.exists) dir.create({ intermediates: true });
}

function assetFor(file: File, format: SpeechFormat, cached: boolean): SpeechAsset {
  return { uri: file.uri, bytes: file.size, cached, format };
}

export function fileSpeechCache(): SpeechCache {
  return {
    async get(key, format) {
      const formats: SpeechFormat[] = format ? [format] : ['mp3', 'wav'];
      for (const candidate of formats) {
        const file = new File(narrationDirectory(), `${key}.${candidate}`);
        if (file.exists) return assetFor(file, candidate, true);
      }
      return null;
    },
    async put(key, bytes, format = 'mp3') {
      const dir = narrationDirectory();
      ensureDirectory(dir);
      const file = new File(dir, `${key}.${format}`);
      if (file.exists) file.delete();
      file.create();
      await file.write(bytes);
      return { uri: file.uri, bytes: bytes.byteLength, cached: false, format };
    },
    async putAt(destPath, bytes, format) {
      const file = new File(destPath);
      if (file.exists) file.delete();
      file.create();
      await file.write(bytes);
      return { uri: file.uri, bytes: bytes.byteLength, cached: false, format };
    },
  };
}

function isAudioContentType(contentType: string): boolean {
  return contentType.startsWith('audio/');
}

function isTextualContentType(contentType: string): boolean {
  return (
    contentType.includes('json') ||
    contentType.startsWith('text/') ||
    contentType.includes('xml') ||
    contentType.includes('html')
  );
}

function formatFromContentType(contentType: string, fallback: SpeechFormat): SpeechFormat {
  if (/audio\/(x-)?wav|audio\/wave/.test(contentType)) return 'wav';
  if (/audio\/(mpeg|mp3)/.test(contentType)) return 'mp3';
  return fallback;
}

/**
 * Keep the file extension honest: an endpoint can ignore `response_format` and
 * answer with WAV even when we asked for MP3. Writing those bytes into a `.mp3`
 * path would make the player decode them as MPEG audio.
 */
function destPathForFormat(destPath: string, format: SpeechFormat): string {
  const extension = /\.([a-z0-9]+)$/i.exec(destPath);
  if (!extension) return `${destPath}.${format}`;
  const current = extension[1].toLowerCase();
  if (current === format) return destPath;
  if (current !== 'mp3' && current !== 'wav') return destPath;
  return `${destPath.slice(0, -extension[0].length)}.${format}`;
}

function previewOfBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes.slice(0, 200)).trim();
  } catch {
    return '';
  }
}

function looksLikeJson(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length && /\s/.test(String.fromCharCode(bytes[index]))) index += 1;
  const first = String.fromCharCode(bytes[index] ?? 0);
  return first === '{' || first === '[';
}

async function bodyPreview(response: Response): Promise<string> {
  try {
    if (typeof response.text === 'function') {
      return (await response.text()).slice(0, 200).trim();
    }
    return previewOfBytes(new Uint8Array(await response.arrayBuffer()));
  } catch {
    return '';
  }
}

export type RemoteSpeechOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  cache?: SpeechCache;
  /** Used to pick capability defaults (`ollama`/`lmstudio` omit `response_format`). */
  presetId?: string;
  /** Override the endpoint capability. */
  supportsResponseFormat?: boolean;
};

export class RemoteSpeechProvider implements SpeechSynthesisProvider {
  readonly id = 'remote-speech';
  readonly label = 'Remote voice';
  readonly requiresKey = true;
  readonly producesFiles = true;
  private supportsResponseFormat: boolean;

  constructor(private options: RemoteSpeechOptions) {
    this.supportsResponseFormat =
      options.supportsResponseFormat ??
      !(options.presetId === 'ollama' || options.presetId === 'lmstudio');
  }

  async isAvailable(): Promise<boolean> {
    if (!this.options.baseUrl) return false;
    const requiresKey = getPreset(this.options.presetId ?? '').requiresKey;
    return !!this.options.apiKey || !requiresKey;
  }

  async synthesize(request: SpeechRequest): Promise<SpeechAsset> {
    if (!(await this.isAvailable())) throw new Error('No speech provider is configured.');
    const cache = this.options.cache ?? fileSpeechCache();
    const key = speechCacheKey(request);

    if (!request.destPath) {
      const hit = await cache.get(key, request.format);
      if (hit) return hit;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    const send = async (includeResponseFormat: boolean): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: request.model,
        voice: request.voice,
        input: request.text,
      };
      if (includeResponseFormat) body.response_format = request.format;
      if (request.instructions && supportsInstructions(request.model)) {
        body.instructions = request.instructions;
      }
      return fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey
            ? { Authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    };

    try {
      let response = await send(this.supportsResponseFormat);

      if (
        !response.ok &&
        response.status === 400 &&
        this.supportsResponseFormat
      ) {
        const preview = await bodyPreview(response);
        if (/response_format/i.test(preview)) {
          // The endpoint lied about (or lacks) response_format support: remember
          // it for this provider instance and retry once without the field.
          this.supportsResponseFormat = false;
          response = await send(false);
        } else {
          throw new Error(`Speech endpoint returned 400. ${preview}`.trim());
        }
      }

      if (!response.ok) {
        const preview = await bodyPreview(response);
        throw new Error(
          `Speech endpoint returned ${response.status}.${preview ? ` ${preview}` : ''}`,
        );
      }

      const contentType = (
        response.headers?.get?.('content-type') ?? ''
      ).toLowerCase();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error('The speech endpoint returned no audio.');

      if (isTextualContentType(contentType) || (!isAudioContentType(contentType) && looksLikeJson(bytes))) {
        const preview = previewOfBytes(bytes);
        throw new Error(
          `The speech endpoint returned a non-audio body: ${preview || '(empty)'}`,
        );
      }

      const format = formatFromContentType(contentType, request.format);
      if (request.destPath && cache.putAt) {
        return await cache.putAt(destPathForFormat(request.destPath, format), bytes, format);
      }
      return await cache.put(key, bytes, format);
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

export class DeviceSpeechProvider implements SpeechSynthesisProvider {
  readonly id = 'device-speech';
  readonly label = 'Device voice';
  readonly requiresKey = false;
  readonly producesFiles = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async synthesize(_request?: SpeechRequest): Promise<SpeechAsset> {
    throw new UnsupportedOperationError('Device speech does not produce audio files.');
  }
}

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
