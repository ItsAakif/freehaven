/**
 * Rendition generation: script → segments → audio.
 *
 * Orchestration only; every model call goes through the existing deep
 * summariser and every synthesis through a `NarrationEngine`. Tests inject a
 * fake provider and a fake engine, so nothing here touches the network.
 */

import type {
  QueuedSegment,
  Rendition,
  RenditionEngine,
  RenditionSegment,
} from '@/domain/narration';
import {
  getRendition,
  listSegments,
  replaceSegments,
  setRenditionDuration,
  setRenditionStatus,
  updateRenditionScript,
  updateSegment,
  updateSegmentOffsets,
} from '@/data/repositories/renditions';
import { getDocument, listSections } from '@/data/repositories/reading';
import { segmentDir, segmentPath } from '@/features/data/paths';
import { summariseBookDeep, type SummaryCheckpoint } from '@/features/learning/summarise';
import { computeOffsets, estimatedDurationMs } from './manifest';
import { wordsForMinutes } from './lengths';
import { maxCharsForEngine, planSpeechSegments } from './segments';
import { speechCacheKey, type SpeechFormat, type SpeechRequest } from './cacheKey';
import { instructionHash, sanitiseInstruction } from './script';
import { getNarrationStyle } from './styles';
import { resolveNarrationEngine, type NarrationEngine } from './engines';

const DEFAULT_REMOTE_MODEL = 'tts-1';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function engineFormat(engine: RenditionEngine): SpeechFormat {
  return engine === 'remote' ? 'mp3' : 'wav';
}

function engineVoice(rendition: Rendition, engine: RenditionEngine): string {
  if (rendition.voice) return rendition.voice;
  const style = getNarrationStyle(rendition.styleId);
  return style.defaultVoices[engine] ?? 'default';
}

function engineModel(rendition: Rendition, engine: RenditionEngine): string {
  if (rendition.model) return rendition.model;
  return engine === 'remote' ? DEFAULT_REMOTE_MODEL : engine;
}

/** Lazy so Jest never imports Expo at module load. */
function documentRoot(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Paths } = require('expo-file-system') as typeof import('expo-file-system');
    return String(Paths.document.uri ?? '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function destPathFor(renditionId: string, ordinal: number, format: SpeechFormat): string {
  return `${documentRoot()}/${segmentPath(renditionId, ordinal, format)}`;
}

/** Create the rendition directory before the first engine write. */
function ensureSegmentDirectory(renditionId: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Directory } = require('expo-file-system') as typeof import('expo-file-system');
    const dir = new Directory(`${documentRoot()}/${segmentDir(renditionId)}`);
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    /* the engine write will surface a precise error */
  }
}

/** Lazy preference read; only remote synthesis needs the endpoint. */
function remoteBaseUrl(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { usePreferences } = require('@/state/preferences') as typeof import('@/state/preferences');
    const url = usePreferences.getState().aiBaseUrl;
    return url ? String(url) : undefined;
  } catch {
    return undefined;
  }
}

function buildRequest(
  rendition: Rendition,
  segment: RenditionSegment,
  engine: RenditionEngine,
  format: SpeechFormat,
): SpeechRequest {
  const style = getNarrationStyle(rendition.styleId);
  return {
    text: segment.text,
    language: rendition.language,
    voice: engineVoice(rendition, engine),
    model: engineModel(rendition, engine),
    engine,
    styleId: style.id,
    instructions: style.directive,
    instructionHash: rendition.instructionHash ?? instructionHash(rendition.instruction ?? ''),
    baseUrl: engine === 'remote' ? remoteBaseUrl() : undefined,
    format,
    destPath: engine === 'device' ? undefined : destPathFor(rendition.id, segment.ordinal, format),
    speakerId: engine === 'kokoro' ? style.kokoroSpeakerId : undefined,
    speed: 1,
  };
}

type ScriptBlock = { heading: string | null; text: string };

/** Split the generated script on `## heading` markers. */
export function splitScriptBlocks(script: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let heading: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) blocks.push({ heading, text });
    lines = [];
  };

  for (const line of script.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
      continue;
    }
    lines.push(line);
  }
  flush();

  return blocks;
}

/**
 * Turn a generated script into an ordered segment plan. The first piece of each
 * block carries the heading as a chapter marker; later pieces carry `null`.
 */
export function planRenditionSegments(input: {
  rendition: Rendition;
  script: string;
  sections?: { id: string; title: string | null }[];
}): QueuedSegment[] {
  const { rendition, script } = input;
  const style = getNarrationStyle(rendition.styleId);
  const engine = rendition.engine;
  const format = engineFormat(engine);
  const maxChars = maxCharsForEngine(engine);
  const blocks = splitScriptBlocks(script);
  const sections = input.sections ?? [];
  const out: QueuedSegment[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const section = block.heading
      ? sections.find(
          (candidate) =>
            (candidate.title ?? '').trim().toLowerCase() === block.heading?.trim().toLowerCase(),
        )
      : undefined;
    const pieces = planSpeechSegments(block.text, maxChars);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      const request: SpeechRequest = {
        text: piece.text,
        language: rendition.language,
        voice: engineVoice(rendition, engine),
        model: engineModel(rendition, engine),
        engine,
        styleId: style.id,
        instructions: style.directive,
        instructionHash: rendition.instructionHash ?? instructionHash(rendition.instruction ?? ''),
        baseUrl: engine === 'remote' ? remoteBaseUrl() : undefined,
        format,
        speakerId: engine === 'kokoro' ? style.kokoroSpeakerId : undefined,
        speed: 1,
      };
      out.push({
        sectionId: section?.id ?? null,
        sectionOrdinal: blockIndex,
        title: pieceIndex === 0 ? block.heading : null,
        text: piece.text,
        speechKey: speechCacheKey(request),
      });
    }
  }

  return out;
}

export async function createScript(input: {
  renditionId: string;
  onProgress?: (p: {
    stage: 'map' | 'merge' | 'reduce' | 'expand';
    done: number;
    total: number;
  }) => void;
  signal?: AbortSignal;
  checkpoint?: SummaryCheckpoint;
}): Promise<{ renditionId: string; words: number; degraded: boolean; truncated: boolean }> {
  const rendition = await getRendition(input.renditionId);
  if (!rendition) throw new Error('Rendition not found.');

  const style = getNarrationStyle(rendition.styleId);
  const targetWords = wordsForMinutes(rendition.length);
  const instruction = sanitiseInstruction(rendition.instruction ?? '');

  await setRenditionStatus(rendition.id, 'scripting');

  try {
    const document = await getDocument(rendition.bookId);
    if (!document) throw new Error('Narration needs extracted text.');

    const [sections, result] = await Promise.all([
      listSections(document.id),
      summariseBookDeep({
        bookId: rendition.bookId,
        kind: 'summary',
        targetWords,
        styleId: style.id,
        instruction: instruction || null,
        persist: false,
        signal: input.signal,
        checkpoint: input.checkpoint,
        onProgress: (progress) => {
          if (progress.stage === 'save') return;
          input.onProgress?.({
            stage: progress.stage,
            done: progress.done,
            total: progress.total,
          });
        },
      }),
    ]);

    await updateRenditionScript(rendition.id, {
      scriptMd: result.text,
      provider: result.provider,
      model: result.model,
      wordCount: result.words,
      status: 'script_ready',
    });

    const segments = planRenditionSegments({
      rendition: { ...rendition, instructionHash: instructionHash(instruction) },
      script: result.text,
      sections: sections.map((section) => ({ id: section.id, title: section.title ?? null })),
    });
    await replaceSegments(
      rendition.id,
      segments.map((segment) => ({ ...segment })),
    );

    return {
      renditionId: rendition.id,
      words: result.words,
      degraded: result.degraded,
      truncated: result.truncated,
    };
  } catch (error) {
    await setRenditionStatus(rendition.id, 'failed', errorMessage(error));
    throw error;
  }
}

export async function synthesiseRendition(input: {
  renditionId: string;
  engine?: NarrationEngine;
  onProgress?: (p: { done: number; total: number; failed: number }) => void;
  onSegment?: (p: {
    ordinal: number;
    speechKey: string;
    status: 'start' | 'done' | 'failed' | 'skipped';
    durationMs?: number;
  }) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ done: number; failed: number }> {
  const rendition = await getRendition(input.renditionId);
  if (!rendition) throw new Error('Rendition not found.');

  const engine =
    input.engine ?? (await resolveNarrationEngine(rendition.engine)).engine;
  await setRenditionStatus(rendition.id, 'synthesising');
  if (engine.producesFiles) ensureSegmentDirectory(rendition.id);

  let segments = await listSegments(rendition.id);
  let done = 0;
  let failed = 0;
  let cancelled = false;

  for (const segment of segments) {
    if (segment.status === 'ready') {
      await input.onSegment?.({
        ordinal: segment.ordinal,
        speechKey: segment.speechKey ?? '',
        status: 'skipped',
        durationMs: segment.durationMs ?? undefined,
      });
      done += 1;
      continue;
    }
    if (input.signal?.aborted) {
      cancelled = true;
      break;
    }

    const format =
      segment.format ?? engineFormat(engine.id);
    const request = buildRequest(rendition, segment, engine.id, format);
    const speechKey = speechCacheKey(request);

    await input.onSegment?.({
      ordinal: segment.ordinal,
      speechKey,
      status: 'start',
    });

    try {
      if (!engine.producesFiles) {
        // Device narration never produces a file; the segment is ready for
        // expo-speech as long as the text is stored.
        await updateSegment(segment.id, {
          status: 'ready',
          filePath: null,
          format: null,
          durationMs: estimatedDurationMs(segment.text),
          bytes: null,
          speechKey,
          error: null,
        });
      } else {
        const asset = await engine.synthesize(request);
        await updateSegment(segment.id, {
          status: 'ready',
          filePath: asset.uri,
          format: asset.format,
          durationMs: estimatedDurationMs(segment.text),
          bytes: asset.bytes,
          speechKey,
          error: null,
        });
      }
      done += 1;
      await input.onSegment?.({
        ordinal: segment.ordinal,
        speechKey,
        status: 'done',
        durationMs: estimatedDurationMs(segment.text),
      });
    } catch (error) {
      failed += 1;
      await updateSegment(segment.id, {
        status: 'failed',
        error: errorMessage(error),
      });
      await input.onSegment?.({
        ordinal: segment.ordinal,
        speechKey,
        status: 'failed',
      });
    }

    input.onProgress?.({ done, total: segments.length, failed });
  }

  input.onProgress?.({ done, total: segments.length, failed });

  if (cancelled) {
    await setRenditionStatus(rendition.id, 'failed', 'cancelled');
    return { done, failed };
  }

  segments = await listSegments(rendition.id);
  const offsets = computeOffsets(
    segments.map((segment) => ({ durationMs: segment.durationMs, text: segment.text })),
  );
  await updateSegmentOffsets(
    rendition.id,
    segments.map((segment, index) => ({ id: segment.id, startMs: offsets[index] })),
  );

  let durationMs = 0;
  for (let index = 0; index < segments.length; index += 1) {
    durationMs =
      offsets[index] +
      (segments[index].durationMs ?? estimatedDurationMs(segments[index].text));
  }
  await setRenditionDuration(rendition.id, durationMs);

  await setRenditionStatus(
    rendition.id,
    failed === 0 ? 'ready' : 'failed',
    failed === 0 ? null : `${failed} segment(s) failed`,
  );

  return { done, failed };
}
