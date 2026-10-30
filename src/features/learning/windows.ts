/**
 * Deterministic planning for whole-book map–reduce.
 *
 * Pure and alias-free (the conformance harness compiles this file directly).
 * Single-tier planning is byte-for-byte the pre-hierarchy algorithm; bands b–d
 * bound per-call input and add a fan-in merge level while keeping full coverage.
 */

import { splitSentences, wordCount } from '../../domain/text';

export interface Window {
  ordinal: number;
  text: string;
  chunkIds: string[];
  charCount: number;
}

export interface SummaryPlan {
  windows: Window[];
  maxReduceLevels: number;
  parts: number;
  estimatedCalls: number;
  targetWords: number;
  coverage: { totalChunks: number; usedChunks: number };
}

export type TierPlan = {
  band: 'single' | 'b' | 'c' | 'd';
  l0MaxChars: number;
  fanIn: number;
  /** 0 for the single-tier path. */
  levels: number;
  /** Level-0 window count. */
  units0: number;
  /** Units per merge level, e.g. [50, 13, 4]. */
  groupCounts: number[];
  totalMergeUnits: number;
  estimatedCalls: number;
  coverage: 'full';
};

export type WindowInput = { id: string; text: string; sectionTitle?: string | null };

type Piece = { chunkId: string; text: string };

export const HIERARCHY_ENABLED = true;

const BAND_L0 = {
  single: 14_000,
  b: 16_000,
  c: 24_000,
  d: 32_000,
} as const;

const BAND_FAN_IN = { b: 4, c: 4, d: 5 } as const;

const BAND_MAX_UNITS = { single: 18, b: 50, c: 84, d: 125 } as const;

const BAND_BUDGET = { single: 28, b: 79, c: 123, d: 167 } as const;

export function splitChunkIntoPieces(chunk: WindowInput, maxChars: number): Piece[] {
  const marker = `[[${chunk.id}]]`;
  const limit = Math.max(1, maxChars - marker.length - 2);
  if (chunk.text.length <= limit) return [{ chunkId: chunk.id, text: `${marker}\n${chunk.text}` }];

  // Split long chunks on sentence boundaries; a single giant sentence is cut at
  // the character limit so a window can never exceed the plan.
  const sentences = splitSentences(chunk.text);
  const raw: string[] = [];
  let current = '';
  const push = (part: string) => {
    if (part.trim()) raw.push(part.trim());
  };

  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > limit) {
      push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const next = current ? `${current} ${rest}` : rest;
    if (next.length > limit && current) {
      push(current);
      current = rest;
    } else {
      current = next;
    }
  }
  push(current);

  return raw.map((text, index) => ({
    chunkId: chunk.id,
    text: `${marker}\n${index > 0 ? '[continued] ' : ''}${text}`,
  }));
}

/**
 * Partition the whole book into at most `maxWindows` windows.
 *
 * Greedy fill respects `maxChars` when the book fits; when it does not, the
 * window target grows so the map stage stays inside the fixed call budget. No
 * chunk is dropped and order is preserved.
 */
export function planWindows(
  chunks: WindowInput[],
  opts: { maxWindows?: number; minChars?: number; maxChars?: number } = {},
): Window[] {
  const maxWindows = Math.max(1, opts.maxWindows ?? 18);
  const minChars = Math.max(1, opts.minChars ?? 4_000);
  const maxCharsCap = Math.max(minChars, opts.maxChars ?? 14_000);
  const nonEmpty = chunks.filter((chunk) => !!chunk.text?.trim());
  if (!nonEmpty.length) return [];

  const total = nonEmpty.reduce((sum, chunk) => sum + chunk.text.length + chunk.id.length + 5, 0);
  const target = Math.ceil(total / maxWindows);
  let maxChars = Math.min(maxCharsCap, Math.max(minChars, target));
  if (maxChars * maxWindows < total) maxChars = Math.max(minChars, target);

  if (nonEmpty.length === 1) {
    const only = nonEmpty[0];
    const text = `[[${only.id}]]\n${only.text}`;
    return [{ ordinal: 0, text, chunkIds: [only.id], charCount: text.length }];
  }

  const pieces = nonEmpty.flatMap((chunk) => splitChunkIntoPieces(chunk, maxChars));
  const windows: Window[] = [];
  let current: Window | null = null;

  for (const piece of pieces) {
    if (current && current.charCount + piece.text.length + 2 > maxChars) {
      windows.push(current);
      current = null;
    }
    if (!current) {
      current = { ordinal: windows.length, text: '', chunkIds: [], charCount: 0 };
    }
    current.text = current.text ? `${current.text}\n\n${piece.text}` : piece.text;
    current.charCount = current.text.length;
    if (!current.chunkIds.includes(piece.chunkId)) current.chunkIds.push(piece.chunkId);
  }
  if (current) windows.push(current);

  // The call budget is the hard constraint: merge the smallest adjacent pair
  // until the window count fits. Order and text are preserved by construction.
  while (windows.length > maxWindows) {
    let bestIndex = 0;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let i = 0; i < windows.length - 1; i += 1) {
      const size = windows[i].charCount + windows[i + 1].charCount;
      if (size < bestSize) {
        bestSize = size;
        bestIndex = i;
      }
    }
    const left = windows[bestIndex];
    const right = windows[bestIndex + 1];
    const merged: Window = {
      ordinal: left.ordinal,
      text: `${left.text}\n\n${right.text}`,
      chunkIds: [...new Set([...left.chunkIds, ...right.chunkIds])],
      charCount: left.charCount + right.charCount + 2,
    };
    windows.splice(bestIndex, 2, merged);
  }

  return windows.map((window, index) => ({ ...window, ordinal: index }));
}

/**
 * Hard-cap-aware variant: windows stay at or below `hardMaxChars` whenever the
 * source has more than one chunk. A single chunk larger than the cap is kept
 * whole (it is already the smallest unit).
 */
export function planWindowsH(
  chunks: WindowInput[],
  opts: { maxWindows?: number; minChars?: number; maxChars?: number; hardMaxChars?: number } = {},
): Window[] {
  const hardMax = Math.max(1, opts.hardMaxChars ?? opts.maxChars ?? BAND_L0.single);
  const maxWindows = Math.max(1, opts.maxWindows ?? 18);
  const nonEmpty = chunks.filter((chunk) => !!chunk.text?.trim());
  if (!nonEmpty.length) return [];

  if (nonEmpty.length === 1) {
    const only = nonEmpty[0];
    const text = `[[${only.id}]]\n${only.text}`;
    return [{ ordinal: 0, text, chunkIds: [only.id], charCount: text.length }];
  }

  // Pack at the hard cap and never raise it. Overlapping source chunks can make
  // the packed count slightly exceed `maxWindows`; that is preferable to a
  // single call carrying more than the band's input budget.
  const pieces = nonEmpty.flatMap((chunk) => splitChunkIntoPieces(chunk, hardMax));
  const windows: Window[] = [];
  let current: Window | null = null;
  for (const piece of pieces) {
    if (current && current.charCount + piece.text.length + 2 > hardMax) {
      windows.push(current);
      current = null;
    }
    if (!current) current = { ordinal: 0, text: '', chunkIds: [], charCount: 0 };
    current.text = current.text ? `${current.text}\n\n${piece.text}` : piece.text;
    current.charCount = current.text.length;
    if (!current.chunkIds.includes(piece.chunkId)) current.chunkIds.push(piece.chunkId);
  }
  if (current) windows.push(current);

  // Merge the smallest adjacent pair only while the result stays under the cap.
  while (windows.length > maxWindows) {
    let bestIndex = -1;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let i = 0; i < windows.length - 1; i += 1) {
      const size = windows[i].charCount + windows[i + 1].charCount + 2;
      if (size <= hardMax && size < bestSize) {
        bestSize = size;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const left = windows[bestIndex];
    const right = windows[bestIndex + 1];
    windows.splice(bestIndex, 2, {
      ordinal: left.ordinal,
      text: `${left.text}\n\n${right.text}`,
      chunkIds: [...new Set([...left.chunkIds, ...right.chunkIds])],
      charCount: left.charCount + right.charCount + 2,
    });
  }

  return windows.map((window, index) => ({ ...window, ordinal: index }));
}

/**
 * Full-coverage invariant: the union of window chunk ids equals the input set.
 * Throws in tests and the strict harness; warns in production.
 */
export function assertFullCoverage(windows: Window[], chunkIds: string[]): void {
  const expected = new Set(chunkIds);
  const covered = new Set<string>();
  for (const window of windows) for (const id of window.chunkIds) covered.add(id);

  const missing = [...expected].filter((id) => !covered.has(id));
  const extra = [...covered].filter((id) => !expected.has(id));
  if (!missing.length && !extra.length) return;

  const message = `Window plan does not cover the input (${missing.length} missing, ${extra.length} unexpected chunk ids).`;
  if (process.env.NODE_ENV === 'test' || process.env.HARNESS_STRICT === '1') {
    throw new Error(message);
  }
  console.warn(message);
}

function bandFor(chars: number): TierPlan['band'] | null {
  if (chars <= 250_000) return 'single';
  if (chars <= 800_000) return 'b';
  if (chars <= 2_000_000) return 'c';
  if (chars <= 4_000_000) return 'd';
  return null;
}

function singlePlan(chars: number): TierPlan {
  const units0 = Math.min(BAND_MAX_UNITS.single, Math.max(1, Math.ceil(chars / BAND_L0.single)));
  return {
    band: 'single',
    l0MaxChars: BAND_L0.single,
    fanIn: 0,
    levels: 0,
    units0,
    groupCounts: [],
    totalMergeUnits: 0,
    estimatedCalls: Math.min(BAND_BUDGET.single, units0 + 2 + 3 + 5),
    coverage: 'full',
  };
}

/**
 * Band table by stripped character count. The explicit call budget is returned
 * so the runner/UI can show "about N model calls" before starting.
 */
export function planTiers(
  totalChars: number,
  opts: { band?: TierPlan['band'] } = {},
): TierPlan {
  const chars = Math.max(0, Math.round(totalChars));
  if (!HIERARCHY_ENABLED || opts.band === 'single') return singlePlan(chars);

  const band = opts.band ?? bandFor(chars);
  if (!band) throw new Error('too_large');
  if (band === 'single') return singlePlan(chars);

  const config = {
    l0MaxChars: BAND_L0[band],
    fanIn: BAND_FAN_IN[band],
    maxUnits: BAND_MAX_UNITS[band],
    levels: 2,
    budget: BAND_BUDGET[band],
  };

  // Markers add ~20 chars per chunk; 8% headroom keeps the packed window count
  // inside `units0` without exceeding the hard per-call cap.
  const estimate = Math.ceil((chars / config.l0MaxChars) * 1.08);
  const units0 = Math.min(config.maxUnits, Math.max(1, estimate));

  const groupCounts: number[] = [];
  let count = units0;
  for (let level = 0; level < config.levels; level += 1) {
    count = Math.ceil(count / config.fanIn);
    groupCounts.push(count);
  }
  const totalMergeUnits = groupCounts.reduce((sum, value) => sum + value, 0);
  const estimatedCalls = Math.min(
    config.budget,
    units0 + totalMergeUnits + 2 + 5 + 5,
  );

  return {
    band,
    l0MaxChars: config.l0MaxChars,
    fanIn: config.fanIn,
    levels: config.levels,
    units0,
    groupCounts,
    totalMergeUnits,
    estimatedCalls,
    coverage: 'full',
  };
}

/** Distribute `targetWords` across 3–5 parts, summing exactly to the target. */
export function planParts(
  outline: { heading: string }[],
  targetWords: number,
): { heading: string; words: number }[] {
  const count = Math.min(5, Math.max(3, Math.ceil(Math.max(0, targetWords) / 800)));
  const headings = Array.from({ length: count }, (_, index) => {
    const heading = outline[index]?.heading?.trim();
    return heading || `Part ${index + 1}`;
  });
  const base = Math.floor(targetWords / count);
  const remainder = targetWords - base * count;
  return headings.map((heading, index) => ({
    heading,
    words: base + (index < remainder ? 1 : 0),
  }));
}

/**
 * Trim prose at the last sentence boundary that fits the budget. Never returns
 * more than `budget` words, even when the first sentence is already over it.
 */
export function trimToWords(text: string, budget: number): string {
  const limit = Math.max(0, Math.floor(budget));
  if (wordCount(text) <= limit) return text;
  const sentences = splitSentences(text);
  let out = '';
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (wordCount(next) > limit) break;
    out = next;
  }
  if (out) return out;
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return words.slice(0, limit).join(' ');
}
