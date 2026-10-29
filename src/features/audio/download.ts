import { markQueueItem, type QueueItem } from '@/data/repositories/audioQueue';
import type { SpeechSynthesisProvider } from './providers';

export type DownloadProgress = {
  done: number;
  total: number;
  skipped: number;
  failed: number;
};

/**
 * Pre-synthesise every queued section so a book can be listened to offline.
 * Already-cached sections are skipped; failures leave the row queued so a later
 * run retries only what is missing.
 */
export async function downloadSections(options: {
  queue: QueueItem[];
  sections: { id: string; title?: string | null; text?: string | null }[];
  provider: SpeechSynthesisProvider;
  voice: string;
  model: string;
  language: string;
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
    const text = (textById.get(item.sectionId) ?? '').slice(0, 4000);
    if (!text.trim()) {
      progress.skipped += 1;
      progress.done += 1;
      options.onProgress?.({ ...progress });
      continue;
    }
    try {
      const asset = await options.provider.synthesize({
        text,
        language: options.language,
        voice: options.voice,
        model: options.model,
      });
      await markQueueItem(item.id, { status: 'ready', filePath: asset.uri });
      progress.done += 1;
    } catch {
      progress.failed += 1;
      progress.done += 1;
    }
    options.onProgress?.({ ...progress });
  }

  return progress;
}
