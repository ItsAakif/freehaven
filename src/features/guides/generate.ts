/**
 * Full Guide generation.
 *
 * A dedicated, resumable chapter loop. It deliberately does not write `jobs`,
 * `job_units` or `rendition_progress`: guide progress is the persisted chapter
 * and segment state, and the runner is a module-scoped in-process map.
 */

import type { AiProvider } from '@/ai/types';
import {
  getGuide,
  getGuideChapter,
  listGuideChapterSegments,
  listGuideChapters,
  replaceGuideChapterSegments,
  setGuideChapterAudio,
  setGuideChapterStatus,
  updateGuideChapterScript,
  updateGuideChapterSegment,
  updateGuideChapterSegmentOffsets,
  setGuideStatus,
} from '@/data/repositories/guides';
import type { GuideChapter } from '@/domain/guides';
import { guideStatusFor } from '@/domain/guides';
import { wordCount } from '@/domain/text';
import { summariseBookDeep, trimToWords } from '@/features/learning/summarise';
import { computeOffsets, estimatedDurationMs } from '@/features/narration/manifest';
import {
  guideChapterDir,
  guideChapterSegmentPath,
} from '@/features/data/paths';
import {
  buildSpeechRequest,
  engineFormat,
  remoteBaseUrl,
} from '@/features/narration/speechRequest';
import { instructionHash } from '@/features/narration/script';
import { getForegroundBridge } from '@/features/jobs/foreground';
import { resolveNarrationEngine, type NarrationEngine } from '@/features/narration/engines';
import { synthesiseRows, type SynthesisRow } from '@/features/narration/synthesisCore';
import {
  GUIDE_CHAPTER_INSTRUCTION,
  GUIDE_CHAPTER_MAX_WORDS,
  GUIDE_CHAPTER_MIN_WORDS,
} from './constants';
import { planChapterSegments } from './segments';

export type GuideMode = 'script' | 'audio' | 'all';

const controllers = new Map<string, AbortController>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PAGE_LABEL_PREFIX = /^\s*page\s+\d+\s*(?:[:\u2014\u2013-]\s*)?/i;

/**
 * PDF imports name each section `Page N`; the summariser can leak that label
 * into the prose. Strip only a line-leading page marker so real prose and
 * titles such as `Page Turners` are untouched.
 */
export function stripPageLabels(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(PAGE_LABEL_PREFIX, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A foreground notification must never fail or delay guide generation. */
function fireForeground(run: () => Promise<void>): void {
  try {
    void run().catch(() => {});
  } catch {
    /* the OS is allowed to refuse a foreground service */
  }
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

function ensureChapterDirectory(guideId: string, chapterId: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Directory } = require('expo-file-system') as typeof import('expo-file-system');
    const dir = new Directory(`${documentRoot()}/${guideChapterDir(guideId, chapterId)}`);
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    /* the engine write will surface a precise error */
  }
}

function chapterSegmentDestPath(
  guideId: string,
  chapterId: string,
  ordinal: number,
  format: 'mp3' | 'wav',
): string {
  return `${documentRoot()}/${guideChapterSegmentPath(guideId, chapterId, ordinal, format)}`;
}

function rowFor(segment: {
  ordinal: number;
  text: string;
  speechKey: string | null;
  status: string;
  filePath: string | null;
  format: 'mp3' | 'wav' | null;
  durationMs: number | null;
  timingsJson: string | null;
}): SynthesisRow {
  return {
    ordinal: segment.ordinal,
    text: segment.text,
    speechKey: segment.speechKey,
    status: segment.status as SynthesisRow['status'],
    filePath: segment.filePath,
    format: segment.format,
    durationMs: segment.durationMs,
    timingsJson: segment.timingsJson,
  };
}

/**
 * Write the 250-word chapter script and (when requested) its audio.
 * Throws after the chapter's failed status is persisted.
 */
export async function generateGuideChapter(input: {
  guideId: string;
  chapterId: string;
  mode: GuideMode;
  engine?: NarrationEngine;
  provider?: AiProvider;
  signal?: AbortSignal;
  rewrite?: boolean;
}): Promise<{ scriptWritten: boolean; audioWritten: boolean; failed: number }> {
  const guide = await getGuide(input.guideId);
  if (!guide) throw new Error('Guide not found.');
  const chapter = await getGuideChapter(input.chapterId);
  if (!chapter || chapter.guideId !== guide.id) throw new Error('Chapter not found.');
  if (!chapter.sectionIds.length) {
    await setGuideChapterStatus(chapter.id, 'failed', 'no_sections');
    throw new Error('no_sections');
  }

  const engine = input.engine ?? (await resolveNarrationEngine(guide.engine)).engine;
  const shouldScript =
    input.mode !== 'audio' && (input.rewrite === true || !chapter.summaryMd);

  let scriptText = chapter.summaryMd;
  let scriptWritten = false;

  if (shouldScript) {
    await setGuideChapterStatus(chapter.id, 'summarising');
    try {
      let result = await summariseBookDeep({
        bookId: guide.bookId,
        kind: 'chapter',
        targetWords: guide.wordsPerChapter,
        styleId: guide.styleId,
        instruction: GUIDE_CHAPTER_INSTRUCTION,
        persist: false,
        sectionIds: chapter.sectionIds,
        title: chapter.title,
        provider: input.provider,
        signal: input.signal,
      });

      let text = stripPageLabels(result.text.trim());
      if (!text) {
        await setGuideChapterStatus(chapter.id, 'failed', 'empty_summary');
        throw new Error('empty_summary');
      }
      let words = wordCount(text);
      if (words > GUIDE_CHAPTER_MAX_WORDS) {
        text = trimToWords(text, GUIDE_CHAPTER_MAX_WORDS);
        words = wordCount(text);
      }

      if (words < GUIDE_CHAPTER_MIN_WORDS) {
        const retry = await summariseBookDeep({
          bookId: guide.bookId,
          kind: 'chapter',
          targetWords: guide.wordsPerChapter,
          styleId: guide.styleId,
          instruction: `${GUIDE_CHAPTER_INSTRUCTION} Expand to at least 212 words.`,
          persist: false,
          sectionIds: chapter.sectionIds,
          title: chapter.title,
          provider: input.provider,
          signal: input.signal,
        });
        const retryText = stripPageLabels(retry.text.trim());
        if (retryText) {
          let retryCandidate = retryText;
          let retryWords = wordCount(retryCandidate);
          if (retryWords > GUIDE_CHAPTER_MAX_WORDS) {
            retryCandidate = trimToWords(retryCandidate, GUIDE_CHAPTER_MAX_WORDS);
            retryWords = wordCount(retryCandidate);
          }
          if (
            Math.abs(retryWords - guide.wordsPerChapter) <
            Math.abs(words - guide.wordsPerChapter)
          ) {
            text = retryCandidate;
            words = retryWords;
            result = retry;
          }
        }
      }

      const error = words < GUIDE_CHAPTER_MIN_WORDS ? 'word_budget' : null;
      const provider = result.degraded ? `${result.provider}+extract` : result.provider;
      await updateGuideChapterScript(chapter.id, {
        summaryMd: text,
        wordCount: words,
        provider,
        model: result.model,
        status: 'scripted',
        error,
      });
      scriptText = text;
      scriptWritten = true;
    } catch (error) {
      await setGuideChapterStatus(chapter.id, 'failed', errorMessage(error));
      throw error;
    }
  }

  const audioWillRun =
    input.mode !== 'script' && !(chapter.status === 'ready' && input.rewrite !== true);
  const summary = scriptText?.trim() ?? '';

  if (audioWillRun && !summary) {
    await setGuideChapterStatus(chapter.id, 'failed', 'no_script');
    throw new Error('no_script');
  }

  if (summary && (scriptWritten || audioWillRun)) {
    const segments = planChapterSegments({
      guide,
      chapter: { id: chapter.id, title: chapter.title, summaryMd: summary },
      engine: engine.id,
    });
    await replaceGuideChapterSegments(chapter.id, segments);
  }

  let audioWritten = false;
  let failed = 0;
  if (audioWillRun) {
    const audio = await synthesiseGuideChapter({
      guideId: guide.id,
      chapterId: chapter.id,
      engine,
      signal: input.signal,
    });
    failed = audio.failed;
    audioWritten = audio.failed === 0;
    if (audio.failed > 0) throw new Error(`audio: ${audio.failed} segment(s) failed`);
  }

  return { scriptWritten, audioWritten, failed };
}

/** Synthesise every queued/failed segment for one chapter and persist offsets. */
export async function synthesiseGuideChapter(input: {
  guideId: string;
  chapterId: string;
  engine?: NarrationEngine;
  onProgress?: (progress: { done: number; total: number; failed: number }) => void;
  signal?: AbortSignal;
}): Promise<{ done: number; failed: number }> {
  const guide = await getGuide(input.guideId);
  if (!guide) throw new Error('Guide not found.');
  const chapter = await getGuideChapter(input.chapterId);
  if (!chapter) throw new Error('Chapter not found.');

  const engine = input.engine ?? (await resolveNarrationEngine(guide.engine)).engine;
  await setGuideChapterStatus(chapter.id, 'synthesising');
  if (engine.producesFiles) ensureChapterDirectory(guide.id, chapter.id);

  let segments = await listGuideChapterSegments(chapter.id);
  if (!segments.length && chapter.summaryMd) {
    segments = await replaceGuideChapterSegments(
      chapter.id,
      planChapterSegments({
        guide,
        chapter: { id: chapter.id, title: chapter.title, summaryMd: chapter.summaryMd },
        engine: engine.id,
      }),
    );
  }
  if (!segments.length) {
    await setGuideChapterStatus(chapter.id, 'failed', 'no_segments');
    throw new Error('no_segments');
  }

  const idByOrdinal = new Map(segments.map((segment) => [segment.ordinal, segment.id]));
  const rows = segments.map(rowFor);

  const result = await synthesiseRows({
    rows,
    engine,
    format: engineFormat(engine.id),
    requestFor: (row) => {
      const format = row.format ?? engineFormat(engine.id);
      return buildSpeechRequest({
        engine: engine.id,
        styleId: guide.styleId,
        language: guide.language,
        voice: guide.voice,
        model: guide.model,
        instruction: null,
        instructionHash: instructionHash(''),
        text: row.text,
        format,
        baseUrl: engine.id === 'remote' ? remoteBaseUrl() : undefined,
        destPath: engine.producesFiles
          ? chapterSegmentDestPath(guide.id, chapter.id, row.ordinal, format)
          : undefined,
      });
    },
    onDone: async (row, patch) => {
      const id = idByOrdinal.get(row.ordinal);
      if (id) await updateGuideChapterSegment(id, patch);
    },
    onFailed: async (row, error) => {
      const id = idByOrdinal.get(row.ordinal);
      if (id) await updateGuideChapterSegment(id, { status: 'failed', error });
    },
    onProgress: input.onProgress,
    signal: input.signal,
  });

  // A cancelled run must not claim the chapter is playable: any segment that
  // was not reached is still queued, so `ready` would hide the remaining work
  // from the guide screen and make a resume skip the chapter. Keep the finished
  // files (they are `ready` rows) and leave the chapter retryable.
  if (result.cancelled) {
    await setGuideChapterStatus(chapter.id, 'failed', 'cancelled');
    return { done: result.done, failed: result.failed };
  }

  const finalSegments = await listGuideChapterSegments(chapter.id);
  const offsets = computeOffsets(
    finalSegments.map((segment) => ({ durationMs: segment.durationMs, text: segment.text })),
  );
  await updateGuideChapterSegmentOffsets(
    chapter.id,
    finalSegments.map((segment, index) => ({ id: segment.id, startMs: offsets[index] })),
  );

  let durationMs = 0;
  for (let index = 0; index < finalSegments.length; index += 1) {
    durationMs =
      offsets[index] +
      (finalSegments[index].durationMs ?? estimatedDurationMs(finalSegments[index].text));
  }

  const audioPath = finalSegments.length === 1 ? finalSegments[0].filePath : null;
  const timingsJson = finalSegments.length === 1 ? finalSegments[0].timingsJson : null;
  await setGuideChapterAudio(chapter.id, { audioPath, durationMs, timingsJson });

  await setGuideChapterStatus(
    chapter.id,
    result.failed === 0 ? 'ready' : 'failed',
    result.failed === 0 ? null : `audio: ${result.failed} segment(s) failed`,
  );

  return { done: result.done, failed: result.failed };
}

export function isGuideRunning(guideId: string): boolean {
  return controllers.has(guideId);
}

export async function cancelGuideGeneration(guideId: string): Promise<void> {
  controllers.get(guideId)?.abort();
}

function shouldSkip(
  chapter: GuideChapter,
  mode: GuideMode,
  rewrite = false,
): 'ready' | 'scripted' | null {
  if (rewrite) return null;
  if (mode !== 'script' && chapter.status === 'ready') return 'ready';
  if (mode === 'script' && chapter.summaryMd && chapter.status !== 'failed') return 'scripted';
  return null;
}

/**
 * Run the guide's chapter loop. The controller is registered before the first
 * await so a second call cannot double-start. A chapter failure never aborts
 * the rest of the guide.
 */
export async function startGuideGeneration(input: {
  guideId: string;
  mode: GuideMode;
  chapterIds?: string[];
  engine?: NarrationEngine;
  provider?: AiProvider;
  signal?: AbortSignal;
  now?: number;
  /** Re-run the selected chapters even when they are already ready (extractive rewrite). */
  rewrite?: boolean;
  onProgress?: (p: {
    done: number;
    total: number;
    failed: number;
    chapterId: string;
  }) => void;
}): Promise<{
  completed: number;
  failed: number;
  cancelled: boolean;
  alreadyRunning: boolean;
}> {
  if (controllers.has(input.guideId)) {
    return { completed: 0, failed: 0, cancelled: false, alreadyRunning: true };
  }

  const controller = new AbortController();
  controllers.set(input.guideId, controller);
  const foreground = getForegroundBridge();
  let foregroundStarted = false;
  const external = input.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }

  let completed = 0;
  let failed = 0;

  try {
    await setGuideStatus(input.guideId, 'generating');
    const guide = await getGuide(input.guideId);
    if (!guide) throw new Error('Guide not found.');

    const all = await listGuideChapters(guide.id);
    const selected = input.chapterIds?.length
      ? input.chapterIds
          .map((id) => all.find((chapter) => chapter.id === id))
          .filter((chapter): chapter is GuideChapter => !!chapter)
      : all;
    const total = selected.length;
    foregroundStarted = true;
    fireForeground(() =>
      foreground.start({
        title: 'Building full guide',
        text: `0 of ${total} chapters`,
      }),
    );

    const reportChapter = (chapter: GuideChapter): void => {
      const processed = completed + failed;
      fireForeground(() =>
        foreground.update({
          text: `Chapter ${processed} of ${total} · ${chapter.title}`,
          progress: total > 0 ? Math.round((processed / total) * 100) : 0,
        }),
      );
    };

    const rewrite = input.rewrite === true && !!input.chapterIds?.length;
    for (const chapter of selected) {
      if (controller.signal.aborted) break;

      const skip = shouldSkip(chapter, input.mode, rewrite);
      if (skip) {
        completed += 1;
        reportChapter(chapter);
        input.onProgress?.({ done: completed, total, failed, chapterId: chapter.id });
        continue;
      }
      if (input.mode === 'audio' && !chapter.summaryMd) {
        await setGuideChapterStatus(chapter.id, 'failed', 'no_script');
        failed += 1;
        reportChapter(chapter);
        input.onProgress?.({ done: completed, total, failed, chapterId: chapter.id });
        continue;
      }

      try {
        await generateGuideChapter({
          guideId: guide.id,
          chapterId: chapter.id,
          mode: input.mode,
          engine: input.engine,
          provider: input.provider,
          signal: controller.signal,
          rewrite,
        });
        completed += 1;
      } catch (error) {
        if (controller.signal.aborted) break;
        await setGuideChapterStatus(chapter.id, 'failed', errorMessage(error));
        failed += 1;
      }

      reportChapter(chapter);
      input.onProgress?.({ done: completed, total, failed, chapterId: chapter.id });
    }

    if (controller.signal.aborted) {
      await setGuideStatus(guide.id, 'partial', 'cancelled');
      return { completed, failed, cancelled: true, alreadyRunning: false };
    }

    const latest = await listGuideChapters(guide.id);
    await setGuideStatus(guide.id, guideStatusFor(latest), null);
    return { completed, failed, cancelled: false, alreadyRunning: false };
  } finally {
    if (foregroundStarted) fireForeground(() => foreground.stop());
    if (external) external.removeEventListener('abort', onExternalAbort);
    controllers.delete(input.guideId);
  }
}
