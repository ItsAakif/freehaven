/**
 * Offline audio download.
 *
 * `downloadRendition` is a thin wrapper over the C7 rendition synthesis loop.
 * `downloadSections` remains for the pre-D3 Listen screen and the legacy
 * `audio_queue`; it now splits text into playable pieces instead of truncating
 * it at 4 000 characters.
 */

import { markQueueItem, type QueueItem } from '@/data/repositories/audioQueue';
import type { SpeechAsset } from './providers';
import type { NarrationStyleId } from '@/domain/narration';
import { planSpeechSegments } from '@/features/narration/segments';
import { synthesiseRendition } from '@/features/narration/generate';
import type { NarrationEngine } from '@/features/narration/engines';

const LEGACY_REMOTE_MAX_CHARS = 3_800;

export type DownloadProgress = {
  done: number;
  total: number;
  skipped: number;
  failed: number;
};

export type LegacySpeechProvider = {
  synthesize(request: {
    text: string;
    language: string;
    voice: string;
    model: string;
    style?: NarrationStyleId;
  }): Promise<SpeechAsset>;
};

/** Segment-based download for a rendition. Failures stay retryable per segment. */
export async function downloadRendition(input: {
  renditionId: string;
  engine?: NarrationEngine;
  onProgress?: (progress: { done: number; total: number; failed: number }) => void;
  signal?: AbortSignal;
}): Promise<{ done: number; failed: number }> {
  return synthesiseRendition(input);
}

/**
 * @deprecated Used by the legacy Listen screen until Contract D3.
 * Pre-synthesise every queued section so a book can be listened to offline.
 */
export async function downloadSections(options: {
  queue: QueueItem[];
  sections: { id: string; title?: string | null; text?: string | null }[];
  provider: LegacySpeechProvider;
  voice: string;
  model: string;
  language: string;
  style?: NarrationStyleId;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<DownloadProgress> {
  const textById = new Map(options.sections.map((s) => [s.id, s.text ?? '']));
  const progress: DownloadProgress = {
    done: 0,
    total: options.queue.length,
    skipped: 0,
    failed: 0,
  };

  for (const item of options.queue) {
    if (item.status === 'ready' && item.filePath) {
      progress.skipped += 1;
      progress.done += 1;
      options.onProgress?.({ ...progress });
      continue;
    }

    const text = textById.get(item.sectionId) ?? '';
    const pieces = planSpeechSegments(text, LEGACY_REMOTE_MAX_CHARS);
    if (!pieces.length) {
      progress.skipped += 1;
      progress.done += 1;
      options.onProgress?.({ ...progress });
      continue;
    }

    try {
      let last: SpeechAsset | null = null;
      for (const piece of pieces) {
        last = await options.provider.synthesize({
          text: piece.text,
          language: options.language,
          voice: options.voice,
          model: options.model,
          style: options.style,
        });
      }
      await markQueueItem(item.id, { status: 'ready', filePath: last?.uri });
      progress.done += 1;
    } catch {
      progress.failed += 1;
      progress.done += 1;
    }
    options.onProgress?.({ ...progress });
  }

  return progress;
}
