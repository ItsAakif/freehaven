/**
 * Shared synthesis loop.
 *
 * Extracted from `synthesiseRendition` so guides and renditions use exactly the
 * same ordering, failure model and duration estimate. The caller supplies the
 * rows, the engine and the persistence hooks.
 */

import type { SpeechFormat, SpeechRequest } from './cacheKey';
import { speechCacheKey } from './cacheKey';
import { estimatedDurationMs } from './manifest';
import type { NarrationEngine } from './engines';

export type SynthesisRow = {
  ordinal: number;
  text: string;
  speechKey: string | null;
  status: 'queued' | 'ready' | 'failed';
  filePath: string | null;
  format?: 'mp3' | 'wav' | null;
  durationMs: number | null;
  timingsJson: string | null;
};

export type SynthesisPatch = {
  status: 'ready' | 'failed';
  speechKey: string;
  filePath?: string | null;
  format?: 'mp3' | 'wav' | null;
  durationMs?: number | null;
  bytes?: number | null;
  timingsJson?: string | null;
  error?: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function synthesiseRows(input: {
  rows: SynthesisRow[];
  engine: NarrationEngine;
  format: SpeechFormat;
  requestFor(row: SynthesisRow): SpeechRequest;
  onStart?(row: SynthesisRow): void | Promise<void>;
  onDone(row: SynthesisRow, patch: SynthesisPatch): Promise<void>;
  onFailed(row: SynthesisRow, error: string): Promise<void>;
  onSegment?(event: {
    ordinal: number;
    speechKey: string;
    status: 'start' | 'done' | 'failed' | 'skipped';
    durationMs?: number;
  }): void | Promise<void>;
  onProgress?(progress: { done: number; total: number; failed: number }): void;
  signal?: AbortSignal;
}): Promise<{ done: number; failed: number; cancelled: boolean }> {
  let done = 0;
  let failed = 0;
  let cancelled = false;

  for (const row of input.rows) {
    if (row.status === 'ready') {
      await input.onSegment?.({
        ordinal: row.ordinal,
        speechKey: row.speechKey ?? '',
        status: 'skipped',
        durationMs: row.durationMs ?? undefined,
      });
      done += 1;
      input.onProgress?.({ done, total: input.rows.length, failed });
      continue;
    }
    if (input.signal?.aborted) {
      cancelled = true;
      break;
    }

    const request = input.requestFor(row);
    const speechKey = speechCacheKey(request);
    await input.onStart?.(row);
    await input.onSegment?.({ ordinal: row.ordinal, speechKey, status: 'start' });

    try {
      if (!input.engine.producesFiles) {
        // Device narration never produces a file; the segment is ready for
        // expo-speech as long as the text is stored.
        await input.onDone(row, {
          status: 'ready',
          speechKey,
          filePath: null,
          format: null,
          durationMs: estimatedDurationMs(row.text),
          bytes: null,
          error: null,
        });
      } else {
        const asset = await input.engine.synthesize(request);
        await input.onDone(row, {
          status: 'ready',
          speechKey,
          filePath: asset.uri,
          format: asset.format,
          durationMs: estimatedDurationMs(row.text),
          bytes: asset.bytes,
          timingsJson: asset.timings?.length ? JSON.stringify(asset.timings) : null,
          error: null,
        });
      }
      done += 1;
      await input.onSegment?.({
        ordinal: row.ordinal,
        speechKey,
        status: 'done',
        durationMs: estimatedDurationMs(row.text),
      });
    } catch (error) {
      failed += 1;
      const message = errorMessage(error);
      await input.onFailed(row, message);
      await input.onSegment?.({ ordinal: row.ordinal, speechKey, status: 'failed' });
    }

    input.onProgress?.({ done, total: input.rows.length, failed });
  }

  input.onProgress?.({ done, total: input.rows.length, failed });

  return { done, failed, cancelled };
}
