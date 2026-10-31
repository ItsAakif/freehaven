/**
 * Whole-book map–reduce summarisation.
 *
 * The planning functions are pure and deterministic. The orchestration takes an
 * `AiProvider`, so tests can drive it with a fake provider and no network. Every
 * failure path ends in text: either the model output, or the deterministic
 * extractive floor from the same source text. Coverage is never sampled.
 */

import { extractiveToBudget } from '@/ai/extractive';
import { resolveProvider } from '@/ai';
import type { AiProvider, AiRequest, AiResponse, GroundedSource } from '@/ai/types';
import { saveSummary } from '@/data/repositories/learning';
import { getDocument, listChunksForBook, listSections } from '@/data/repositories/reading';
import { wordCount } from '@/domain/text';
import type { Chunk, SummaryKind } from '@/domain/types';
import { getNarrationStyle } from '@/features/narration/styles';
import type { NarrationStyleId } from '@/domain/narration';
import { fnv1a32 } from '@/lib/hash';
import {
  assertFullCoverage,
  planParts,
  planTiers,
  planWindows,
  planWindowsH,
  trimToWords,
  type WindowInput,
} from './windows';

export {
  HIERARCHY_ENABLED,
  assertFullCoverage,
  planParts,
  planTiers,
  planWindows,
  planWindowsH,
  trimToWords,
  type SummaryPlan,
  type TierPlan,
  type Window,
} from './windows';

export const WORDS_PER_MINUTE = 145;

const MAX_CALLS = 28;
const MAX_SOURCE_IDS = 2_000;
const MAX_BATCH_CHARS = 12_000;
const MAX_NOTE_CHARS = 400;
const MAP_OUTPUT_TOKENS = 700;
const REDUCE_OUTPUT_TOKENS = 1_200;
const LONG_CALL_TIMEOUT_MS = 90_000;

export function wordsForMinutes(minutes: 5 | 15 | 25): number {
  return minutes * WORDS_PER_MINUTE;
}

const LENGTH_WORDS: Record<'short' | 'medium' | 'long', number> = {
  short: 250,
  medium: 700,
  long: 1_400,
};

export function lengthToWords(length: 'short' | 'medium' | 'long'): number {
  return LENGTH_WORDS[length] ?? LENGTH_WORDS.medium;
}

/** True when `actual` is within ±15% of `target`. */
export function withinTolerance(actual: number, target: number): boolean {
  if (target <= 0) return actual === 0;
  return Math.abs(actual - target) <= target * 0.15;
}


type Note = { text: string; chunkIds: string[]; sectionTitle: string | null };
type OutlinePoint = { text: string; chunkIds: string[] };
type OutlineHeading = { heading: string; points: OutlinePoint[] };

function normaliseLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function parseNotes(text: string, fallbackIds: string[], sectionTitle: string | null): Note[] {
  const parsed = parseJsonText(text);
  const container = asRecord(parsed);
  const jsonNotes = container && Array.isArray(container.notes) ? container.notes : null;
  if (jsonNotes) {
    const notes: Note[] = [];
    for (const item of jsonNotes) {
      const record = asRecord(item);
      const rawText = typeof item === 'string' ? item : record ? record.text : '';
      if (typeof rawText !== 'string' || !rawText.trim()) continue;
      const rawIds = record?.chunkIds ?? record?.chunk_ids ?? [];
      const chunkIds = Array.isArray(rawIds)
        ? rawIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
        : [];
      notes.push({
        text: rawText.trim().slice(0, MAX_NOTE_CHARS),
        chunkIds: chunkIds.length ? chunkIds : [...fallbackIds],
        sectionTitle,
      });
    }
    if (notes.length) return notes;
  }

  const lines = text
    .replace(/^\s*NOTES:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('```'));

  const notes: Note[] = [];
  for (const line of lines) {
    let rest = line.replace(/^[-*]\s+/, '').trim();
    if (!rest || rest.startsWith('#')) continue;
    let chunkIds: string[] = [];
    const marker = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (marker) {
      chunkIds = marker[1]
        .split(/[,\s]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      rest = marker[2].trim();
    }
    if (!rest) continue;
    notes.push({
      text: rest.slice(0, MAX_NOTE_CHARS),
      chunkIds: chunkIds.length ? chunkIds : [...fallbackIds],
      sectionTitle,
    });
  }
  return notes;
}

function idsForPoint(point: string, notes: Note[]): string[] {
  const normalised = normaliseLine(point);
  if (!normalised) return [];
  const ids: string[] = [];
  for (const note of notes) {
    const noteText = normaliseLine(note.text);
    if (!noteText) continue;
    if (noteText.includes(normalised) || normalised.includes(noteText)) {
      for (const id of note.chunkIds) if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function parseOutline(text: string, fallback: { heading: string; notes: Note[] }[]): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  let current: OutlineHeading | null = null;
  const allNotes = fallback.flatMap((entry) => entry.notes);

  const parsed = parseJsonText(text);
  const container = asRecord(parsed);
  const jsonOutline = Array.isArray(parsed)
    ? parsed
    : container && Array.isArray(container.outline)
      ? container.outline
      : null;
  if (jsonOutline) {
    for (const item of jsonOutline) {
      const record = asRecord(item);
      if (!record) continue;
      const headingText = typeof record.heading === 'string' ? record.heading.trim() : '';
      if (!headingText) continue;
      const rawPoints = Array.isArray(record.points) ? record.points : [];
      const headingIds = Array.isArray(record.chunkIds)
        ? record.chunkIds.filter((id): id is string => typeof id === 'string')
        : [];
      const points: OutlinePoint[] = [];
      for (const rawPoint of rawPoints) {
        const pointRecord = asRecord(rawPoint);
        const pointText =
          typeof rawPoint === 'string' ? rawPoint : pointRecord && typeof pointRecord.text === 'string' ? pointRecord.text : '';
        if (!pointText.trim()) continue;
        const pointIds = pointRecord && Array.isArray(pointRecord.chunkIds)
          ? pointRecord.chunkIds.filter((id): id is string => typeof id === 'string')
          : [];
        points.push({
          text: pointText.trim(),
          chunkIds: pointIds.length ? pointIds : idsForPoint(pointText, allNotes),
        });
      }
      headings.push({
        heading: headingText,
        points: points.length
          ? points
          : headingIds.map((id) => ({ text: headingText, chunkIds: [id] })),
      });
    }
    if (headings.length) return headings;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    if (line.startsWith('#')) {
      const heading = line.replace(/^#+\s*/, '').trim();
      if (!heading) continue;
      current = { heading, points: [] };
      headings.push(current);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!current) {
        current = { heading: 'Part 1', points: [] };
        headings.push(current);
      }
      const point = line.replace(/^[-*]\s+/, '').trim();
      if (point) current.points.push({ text: point, chunkIds: idsForPoint(point, allNotes) });
      continue;
    }
    if (!current) {
      current = { heading: line.replace(/[:.]+$/, '').trim() || 'Part 1', points: [] };
      headings.push(current);
    }
  }

  if (headings.length) return headings;

  return fallback
    .filter((entry) => entry.notes.length)
    .map((entry) => ({
      heading: entry.heading,
      points: entry.notes.map((note) => ({ text: note.text, chunkIds: [...note.chunkIds] })),
    }));
}

function mergeOutlines(outlines: OutlineHeading[]): OutlineHeading[] {
  const merged: OutlineHeading[] = [];
  for (const heading of outlines) {
    const existing = merged.find(
      (item) => normaliseLine(item.heading) === normaliseLine(heading.heading),
    );
    if (!existing) {
      merged.push({ heading: heading.heading, points: [...heading.points] });
      continue;
    }
    for (const point of heading.points) {
      if (
        !existing.points.some(
          (item) => normaliseLine(item.text) === normaliseLine(point.text),
        )
      ) {
        existing.points.push(point);
      }
    }
  }
  return merged;
}

/** Flatten an outline into notes so the next merge level can group it. */
function outlineToNotes(outline: OutlineHeading[]): Note[] {
  const notes: Note[] = [];
  for (const heading of outline) {
    if (!heading.points.length) {
      notes.push({ text: heading.heading.slice(0, MAX_NOTE_CHARS), chunkIds: [], sectionTitle: null });
      continue;
    }
    for (const point of heading.points) {
      notes.push({
        text: `${heading.heading}: ${point.text}`.slice(0, MAX_NOTE_CHARS),
        chunkIds: [...point.chunkIds],
        sectionTitle: null,
      });
    }
  }
  return notes;
}

/** Failed merge group: concatenated child notes (never sampled), capped at 2 400. */
function mergeFallbackOutline(notes: Note[], ordinal: number): OutlineHeading[] {
  const text = notes
    .map((note) => note.text)
    .join('\n')
    .slice(0, 6 * MAX_NOTE_CHARS);
  const chunkIds = [...new Set(notes.flatMap((note) => note.chunkIds))];
  return text
    ? [{ heading: `Part ${ordinal + 1}`, points: [{ text, chunkIds }] }]
    : [];
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function throwIfAborted(signal: AbortSignal | undefined, checkpoint?: SummaryCheckpoint): void {
  if (signal?.aborted) throw new Error('Summarisation cancelled.');
  if (checkpoint?.cancelled()) throw new Error('cancelled');
}

/**
 * Persisted result for one map/merge/reduce/expand unit.
 *
 * The third argument is the unit's input signature; the job layer scopes it
 * with the job's stage key before storing. When no checkpoint is supplied the
 * orchestrator follows exactly the pre-v6 code path.
 */
export type SummaryCheckpoint = {
  /** Return a previously persisted result for this unit, or null. */
  load(
    stage: 'map' | 'merge' | 'reduce' | 'expand',
    ordinal: number,
    inputKey: string,
  ): Promise<unknown | null>;
  begin(
    stage: 'map' | 'merge' | 'reduce' | 'expand',
    ordinal: number,
    inputKey: string,
    payload: unknown,
  ): Promise<void>;
  save(
    stage: 'map' | 'merge' | 'reduce' | 'expand',
    ordinal: number,
    inputKey: string,
    result: unknown,
    durationMs: number,
  ): Promise<void>;
  fail(
    stage: 'map' | 'merge' | 'reduce' | 'expand',
    ordinal: number,
    inputKey: string,
    error: string,
    durationMs: number,
  ): Promise<void>;
  /** True when the user cancelled; checked at every unit boundary. */
  cancelled(): boolean;
};

/** Deterministic per-unit input signature. The job layer adds its stage key. */
function checkpointKey(
  stage: 'map' | 'merge' | 'reduce' | 'expand',
  ordinal: number,
  unitInput: string,
): string {
  return fnv1a32(`${stage}|${ordinal}|${fnv1a32(unitInput)}`);
}

function sourceFor(chunk: Chunk, titles: Map<string, string>): GroundedSource {
  return {
    chunkId: chunk.id,
    text: chunk.text,
    page: chunk.page,
    sectionTitle: chunk.sectionId ? (titles.get(chunk.sectionId) ?? null) : null,
  };
}

function extractiveFallbackText(chunks: Chunk[], targetWords: number): string {
  const joined = chunks.map((chunk) => chunk.text).join('\n\n');
  let text = extractiveToBudget(joined, targetWords);
  if (wordCount(text) > targetWords * 1.15) text = trimToWords(text, targetWords);
  return text;
}

export type DeepSummaryResult = {
  summaryId: string | null;
  text: string;
  provider: string;
  model: string | null;
  degraded: boolean;
  truncated: boolean;
  words: number;
  calls: number;
  sourceChunkIds: string[];
};

export async function summariseBookDeep(input: {
  bookId: string;
  kind: SummaryKind;
  targetWords: number;
  styleId?: NarrationStyleId;
  instruction?: string | null;
  provider?: AiProvider;
  /** Default true. Narration scripts pass false: nothing is written to `summaries`. */
  persist?: boolean;
  onProgress?: (p: {
    stage: 'map' | 'merge' | 'reduce' | 'expand' | 'save';
    done: number;
    total: number;
  }) => void;
  signal?: AbortSignal;
  /** Optional resumable checkpoint store. Omitted, the pipeline is unchanged. */
  checkpoint?: SummaryCheckpoint;
  /** Internal used by chapter summaries; omitted by the spec's public callers. */
  sectionId?: string | null;
  /** Multi-section scope for guide chapters. Takes precedence over `sectionId` when non-empty. */
  sectionIds?: string[];
  title?: string;
}): Promise<DeepSummaryResult> {
  const persist = input.persist !== false;
  const targetWords = Math.max(1, Math.round(input.targetWords));

  throwIfAborted(input.signal, input.checkpoint);

  const provider = input.provider ?? (await resolveProvider());

  const allChunks = await listChunksForBook(input.bookId);
  const document = await getDocument(input.bookId);
  const titles = new Map<string, string>();
  if (document) {
    for (const section of await listSections(document.id)) {
      if (section.title) titles.set(section.id, section.title);
    }
  }
  const scope = input.sectionIds?.length ? new Set(input.sectionIds) : null;
  const chunks = scope
    ? allChunks.filter((chunk) => !!chunk.sectionId && scope.has(chunk.sectionId))
    : input.sectionId
      ? allChunks.filter((chunk) => chunk.sectionId === input.sectionId)
      : allChunks;
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const windowInputs: WindowInput[] = chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    sectionTitle: chunk.sectionId ? (titles.get(chunk.sectionId) ?? null) : null,
  }));
  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const tier = planTiers(totalChars);
  const hierarchical = tier.levels > 0;
  const windows = hierarchical
    ? planWindowsH(windowInputs, {
        maxWindows: tier.units0,
        minChars: 4_000,
        maxChars: tier.l0MaxChars,
        hardMaxChars: tier.l0MaxChars,
      })
    : planWindows(windowInputs);
  if (hierarchical) {
    assertFullCoverage(
      windows,
      windowInputs.filter((chunk) => !!chunk.text.trim()).map((chunk) => chunk.id),
    );
  }

  const sourceChunkIds: string[] = [];
  for (const window of windows) {
    for (const id of window.chunkIds) {
      if (chunkById.has(id) && !sourceChunkIds.includes(id) && sourceChunkIds.length < MAX_SOURCE_IDS) {
        sourceChunkIds.push(id);
      }
    }
  }

  let calls = 0;
  let model: string | null = null;
  let sawDegraded = false;
  let truncated = false;

  const call = async (request: AiRequest) => {
    calls += 1;
    const response = await provider.generate(request);
    if (response.model) model = response.model;
    if (response.degraded) sawDegraded = true;
    if (response.truncated) truncated = true;
    return response;
  };

  if (!windows.length) {
    throwIfAborted(input.signal, input.checkpoint);
    if (persist) {
      input.onProgress?.({ stage: 'save', done: 0, total: 1 });
    }
    return {
      summaryId: null,
      text: '',
      provider: provider.id,
      model: null,
      degraded: false,
      truncated: false,
      words: 0,
      calls: 0,
      sourceChunkIds: [],
    };
  }

  const stylePreset = input.styleId ? getNarrationStyle(input.styleId) : null;
  // The expand prompt only carries one style string, so compose the whole
  // preset (label, persona, delivery, structural rules and filler ceiling) into
  // it. Otherwise the style data would only affect the one-line delivery hint.
  const styleDirective = stylePreset
    ? [
        `${stylePreset.label} — ${stylePreset.persona}`,
        stylePreset.directive,
        `Rules: ${stylePreset.scriptRules.join(' ')}`,
        `Connective commentary must stay under ${Math.round(stylePreset.fillerBudget * 100)}% of sentences.`,
      ].join(' ')
    : undefined;

  /* ------------------------------------------------------------------- map */
  let mapDone = 0;
  let mapFailures = 0;
  const mapResults = await mapLimit(windows, 2, async (window) => {
    throwIfAborted(input.signal, input.checkpoint);
    const ids = [...new Set(window.chunkIds)];
    const sources = ids
      .map((id) => chunkById.get(id))
      .filter((chunk): chunk is Chunk => !!chunk)
      .map((chunk) => sourceFor(chunk, titles));
    const request: AiRequest = {
      task: 'notes',
      sources: sources.length
        ? sources
        : [{ chunkId: `window-${window.ordinal}`, text: window.text, page: null, sectionTitle: null }],
      maxOutputTokens: MAP_OUTPUT_TOKENS,
      timeoutMs: LONG_CALL_TIMEOUT_MS,
      instruction:
        'Prefix every note with the chunk id in brackets. Keep names, numbers and technical terms.',
    };
    const checkpoint = input.checkpoint;
    const key = checkpointKey('map', window.ordinal, window.text);

    if (checkpoint) {
      const stored = await checkpoint.load('map', window.ordinal, key);
      if (Array.isArray(stored)) {
        mapDone += 1;
        input.onProgress?.({ stage: 'map', done: mapDone, total: windows.length });
        return stored as Note[];
      }
      await checkpoint.begin('map', window.ordinal, key, { text: window.text });
    }

    const startedAt = Date.now();
    let response: AiResponse;
    try {
      response = await call(request);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (checkpoint) {
        await checkpoint.fail(
          'map',
          window.ordinal,
          key,
          error instanceof Error ? error.message : String(error),
          Date.now() - startedAt,
        );
      }
      mapFailures += 1;
      mapDone += 1;
      input.onProgress?.({ stage: 'map', done: mapDone, total: windows.length });
      return [] as Note[];
    }

    const notes = parseNotes(response.text, ids, sources[0]?.sectionTitle ?? null);
    if (checkpoint) {
      await checkpoint.save('map', window.ordinal, key, notes, Date.now() - startedAt);
    }
    mapDone += 1;
    input.onProgress?.({ stage: 'map', done: mapDone, total: windows.length });
    return notes;
  });

  throwIfAborted(input.signal, input.checkpoint);

  const allNotes = mapResults.flat();
  const failureRatio = mapFailures / windows.length;
  if (failureRatio >= 0.3 || allNotes.length === 0) {
    const text = extractiveFallbackText(chunks, targetWords);
    throwIfAborted(input.signal, input.checkpoint);
    if (persist) input.onProgress?.({ stage: 'save', done: 0, total: 1 });
    const words = wordCount(text);
    const summary = persist
      ? await saveSummary({
          bookId: input.bookId,
          kind: input.kind,
          title: input.title ?? defaultTitle(input.kind),
          bodyMd: text,
          provider: 'extractive',
          model: null,
          sectionId: input.sectionId ?? null,
          sourceChunkIds,
        })
      : null;
    return {
      summaryId: summary?.id ?? null,
      text,
      provider: 'extractive',
      model: null,
      degraded: true,
      truncated: words < targetWords * 0.85,
      words,
      calls,
      sourceChunkIds,
    };
  }

  /* ----------------------------------------------------------------- merge */
  let mergedOutline: OutlineHeading[] = [];
  let mergeOrdinal = 0;
  let mergeDone = 0;
  let mergeFallback = false;
  if (hierarchical) {
    let levelNotes: Note[][] = mapResults;
    for (let level = 1; level <= tier.levels; level += 1) {
      const groups: Note[][] = [];
      for (let index = 0; index < levelNotes.length; index += tier.fanIn) {
        groups.push(levelNotes.slice(index, index + tier.fanIn).flat());
      }
      const levelStart = mergeOrdinal;
      const outlinesForLevel = await mapLimit(groups, 2, async (groupNotes, groupIndex) => {
        throwIfAborted(input.signal, input.checkpoint);
        const ordinal = levelStart + groupIndex;
        const inputText = groupNotes
          .map((note) => note.text)
          .join('\n')
          .slice(0, 10_000);
        const checkpoint = input.checkpoint;
        const key = checkpointKey('merge', ordinal, inputText);
        if (checkpoint) {
          const stored = await checkpoint.load('merge', ordinal, key);
          if (Array.isArray(stored)) {
            mergeDone += 1;
            input.onProgress?.({ stage: 'merge', done: mergeDone, total: tier.totalMergeUnits });
            return stored as OutlineHeading[];
          }
          await checkpoint.begin('merge', ordinal, key, { notes: groupNotes });
        }

        const firstOrdinal = (level === 1 ? 0 : levelStart) + groupIndex * tier.fanIn;
        const request: AiRequest = {
          task: 'outline',
          sources: [
            {
              chunkId: `note:${level}:${firstOrdinal}`,
              text: inputText,
              page: null,
              sectionTitle: groupNotes[0]?.sectionTitle ?? null,
            },
          ],
          maxOutputTokens: REDUCE_OUTPUT_TOKENS,
          timeoutMs: LONG_CALL_TIMEOUT_MS,
          instruction: 'Merge these notes into a single outline, preserving the order of the book.',
        };

        const startedAt = Date.now();
        let response: AiResponse;
        try {
          response = await call(request);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          if (checkpoint) {
            await checkpoint.fail(
              'merge',
              ordinal,
              key,
              error instanceof Error ? error.message : String(error),
              Date.now() - startedAt,
            );
          }
          mergeDone += 1;
          mergeFallback = true;
          input.onProgress?.({ stage: 'merge', done: mergeDone, total: tier.totalMergeUnits });
          return mergeFallbackOutline(groupNotes, ordinal);
        }

        const parsed = parseOutline(response.text, [
          { heading: `Part ${ordinal + 1}`, notes: groupNotes },
        ]);
        const outline = parsed.length ? parsed : mergeFallbackOutline(groupNotes, ordinal);
        if (checkpoint) {
          await checkpoint.save('merge', ordinal, key, outline, Date.now() - startedAt);
        }
        mergeDone += 1;
        input.onProgress?.({ stage: 'merge', done: mergeDone, total: tier.totalMergeUnits });
        return outline;
      });

      mergeOrdinal += groups.length;
      if (level === tier.levels) mergedOutline = outlinesForLevel.flat();
      else levelNotes = outlinesForLevel.map(outlineToNotes);
    }
    throwIfAborted(input.signal, input.checkpoint);
  }

  /* ---------------------------------------------------------------- reduce */
  const notesForReduce = hierarchical ? outlineToNotes(mergedOutline) : allNotes;
  const fallbackOutline: OutlineHeading[] =
    hierarchical && mergedOutline.length
      ? mergedOutline
      : windows.map((window, index) => ({
          heading: `Part ${index + 1}`,
          points: mapResults[index].map((note) => ({ text: note.text, chunkIds: [...note.chunkIds] })),
        }));

  const batches: Note[][] = [];
  let batch: Note[] = [];
  let batchChars = 0;
  for (const note of notesForReduce) {
    const size = note.text.length + 8;
    if (batch.length && batchChars + size > MAX_BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }
    batch.push(note);
    batchChars += size;
  }
  if (batch.length) batches.push(batch);

  const maxCalls = hierarchical ? tier.estimatedCalls : MAX_CALLS;
  const reduceBudget = Math.max(
    1,
    maxCalls - windows.length - (hierarchical ? tier.totalMergeUnits : 0) - 5,
  );
  if (batches.length > reduceBudget) {
    const head = batches.slice(0, reduceBudget - 1);
    const tail = batches.slice(reduceBudget - 1).flat();
    batches.length = 0;
    batches.push(...head, tail);
  }

  const partialOutlines: OutlineHeading[] = [];
  let reduceDone = 0;
  for (const notes of batches) {
    throwIfAborted(input.signal, input.checkpoint);
    const checkpoint = input.checkpoint;
    const reduceInput = notes.map((note) => note.text).join('\n');
    const key = checkpointKey('reduce', reduceDone, reduceInput);
    if (checkpoint) {
      const stored = await checkpoint.load('reduce', reduceDone, key);
      if (Array.isArray(stored)) {
        const restored = stored as OutlineHeading[];
        if (restored.length) partialOutlines.push(...restored);
        reduceDone += 1;
        input.onProgress?.({ stage: 'reduce', done: reduceDone, total: batches.length });
        continue;
      }
      await checkpoint.begin('reduce', reduceDone, key, { notes });
    }

    const sources: GroundedSource[] = notes.map((note, index) => ({
      chunkId: note.chunkIds[0] ?? `note-${reduceDone}-${index}`,
      text: note.text,
      page: null,
      sectionTitle: note.sectionTitle,
    }));
    const startedAt = Date.now();
    let response: AiResponse;
    try {
      response = await call({
        task: 'outline',
        sources,
        maxOutputTokens: REDUCE_OUTPUT_TOKENS,
        timeoutMs: LONG_CALL_TIMEOUT_MS,
        instruction: 'Merge these notes into a single outline, preserving the order of the book.',
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (checkpoint) {
        await checkpoint.fail(
          'reduce',
          reduceDone,
          key,
          error instanceof Error ? error.message : String(error),
          Date.now() - startedAt,
        );
      }
      partialOutlines.push({
        heading: `Part ${reduceDone + 1}`,
        points: notes.map((note) => ({ text: note.text, chunkIds: [...note.chunkIds] })),
      });
      reduceDone += 1;
      input.onProgress?.({ stage: 'reduce', done: reduceDone, total: batches.length });
      continue;
    }

    const parsed = parseOutline(response.text, [
      { heading: `Part ${reduceDone + 1}`, notes },
    ]);
    if (checkpoint) {
      await checkpoint.save('reduce', reduceDone, key, parsed, Date.now() - startedAt);
    }
    if (parsed.length) partialOutlines.push(...parsed);
    reduceDone += 1;
    input.onProgress?.({ stage: 'reduce', done: reduceDone, total: batches.length });
  }

  throwIfAborted(input.signal, input.checkpoint);

  const outline = mergeOutlines(partialOutlines.length ? partialOutlines : fallbackOutline);
  const effectiveOutline = outline.length ? outline : fallbackOutline;
  const parts = planParts(effectiveOutline, targetWords);

  /* ---------------------------------------------------------------- expand */
  const partTexts: string[] = [];
  let partial = false;
  let expandDone = 0;

  for (let index = 0; index < parts.length; index += 1) {
    throwIfAborted(input.signal, input.checkpoint);
    const part = parts[index];
    const outlinePart = effectiveOutline[index];
    const points = outlinePart?.points ?? [];
    const ids = new Set<string>();
    for (const point of points) {
      for (const id of point.chunkIds) ids.add(id);
    }

    // Prefer the chunks the outline points cite, then top up from the part's
    // window slice so the deterministic extractive floor always has enough
    // source text to fill its word budget. The character budget keeps remote
    // prompts bounded for very large books.
    const partSources: GroundedSource[] = [];
    const seenIds = new Set<string>();
    const charBudget = Math.min(12_000, Math.max(2_000, part.words * 10));
    let sourceChars = 0;
    const addChunkSource = (id: string) => {
      if (seenIds.has(id) || sourceChars >= charBudget) return;
      const chunk = chunkById.get(id);
      if (!chunk) return;
      seenIds.add(id);
      partSources.push(sourceFor(chunk, titles));
      sourceChars += chunk.text.length;
    };

    for (const id of ids) addChunkSource(id);

    const start = Math.floor((index * windows.length) / parts.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) * windows.length) / parts.length));
    for (const window of windows.slice(start, end)) {
      for (const id of window.chunkIds) addChunkSource(id);
    }

    if (!partSources.length) {
      for (const window of windows) {
        for (const id of window.chunkIds) addChunkSource(id);
      }
    }

    const checkpoint = input.checkpoint;
    const expandInput = `${part.heading}|${part.words}|${partSources
      .map((source) => source.chunkId)
      .join(',')}`;
    const key = checkpointKey('expand', index, expandInput);
    if (checkpoint) {
      const stored = await checkpoint.load('expand', index, key);
      if (typeof stored === 'string') {
        partTexts.push(stored);
        expandDone += 1;
        input.onProgress?.({ stage: 'expand', done: expandDone, total: parts.length });
        continue;
      }
      await checkpoint.begin('expand', index, key, { part });
    }

    const request: AiRequest = {
      task: 'script',
      sources: partSources,
      targetWords: part.words,
      styleDirective,
      instruction: input.instruction ?? null,
      maxOutputTokens: Math.ceil(part.words * 2.2),
      timeoutMs: LONG_CALL_TIMEOUT_MS,
    };

    const startedAt = Date.now();
    let text: string;
    try {
      const response = await call(request);
      text = response.text.trim();
      if (wordCount(text) < part.words * 0.75 && calls + 1 <= maxCalls) {
        const missing = Math.max(1, part.words - wordCount(text));
        const topUp = await call({
          ...request,
          targetWords: missing,
          instruction: `Add ${missing} words of additional detail using only these notes.`,
        });
        if (topUp.text.trim()) text = `${text}\n\n${topUp.text.trim()}`;
      }
      if (wordCount(text) > part.words * 1.35) text = trimToWords(text, part.words);
      if (wordCount(text) < part.words * 0.75) truncated = true;
      if (!text) {
        text = points.length
          ? [`## ${part.heading}`, ...points.map((point) => `- ${point.text}`)].join('\n')
          : `## ${part.heading}`;
        partial = true;
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (checkpoint) {
        await checkpoint.fail(
          'expand',
          index,
          key,
          error instanceof Error ? error.message : String(error),
          Date.now() - startedAt,
        );
      }
      partial = true;
      truncated = true;
      text = points.length
        ? [`## ${part.heading}`, ...points.map((point) => `- ${point.text}`)].join('\n')
        : `## ${part.heading}`;
    }

    if (checkpoint) {
      await checkpoint.save('expand', index, key, text, Date.now() - startedAt);
    }
    partTexts.push(text);
    expandDone += 1;
    input.onProgress?.({ stage: 'expand', done: expandDone, total: parts.length });
  }

  throwIfAborted(input.signal, input.checkpoint);

  const text = parts
    .map((part, index) => {
      const body = partTexts[index] ?? '';
      return body.startsWith('## ')
        ? body
        : [`## ${part.heading}`, body].filter(Boolean).join('\n\n');
    })
    .join('\n\n')
    .trim();

  const words = wordCount(text);
  const degraded = sawDegraded || partial || mergeFallback;

  throwIfAborted(input.signal, input.checkpoint);
  if (persist) input.onProgress?.({ stage: 'save', done: 0, total: 1 });

  const summary = persist
    ? await saveSummary({
        bookId: input.bookId,
        kind: input.kind,
        title: input.title ?? defaultTitle(input.kind),
        bodyMd: text,
        provider: provider.id,
        model,
        sectionId: input.sectionId ?? null,
        sourceChunkIds,
      })
    : null;

  return {
    summaryId: summary?.id ?? null,
    text,
    provider: provider.id,
    model,
    degraded,
    truncated,
    words,
    calls,
    sourceChunkIds,
  };
}

function defaultTitle(kind: SummaryKind): string {
  if (kind === 'lesson') return 'Lesson';
  if (kind === 'takeaways') return 'Key takeaways';
  if (kind === 'concepts') return 'Concepts';
  if (kind === 'chapter') return 'Chapter';
  return 'Summary';
}
