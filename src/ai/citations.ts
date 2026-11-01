/**
 * Citation verification by substring.
 *
 * Prompt instructions are not a guarantee. Every quote shown as evidence has
 * to appear in the source chunk; otherwise it is repaired to the chunk's best
 * supporting sentence or dropped.
 */

import { bestSupportingSentence } from '@/domain/retrieval';
import type { Chunk, Citation } from '@/domain/types';
import type { AiRequest } from './types';

const MIN_WORDS = 8;
const MIN_SHORT_QUOTE_CHARS = 40;
const MAX_CITATIONS = 6;

const CURLY_SINGLE = /[\u2018\u2019\u201A\u201B\u2032]/g;
const CURLY_DOUBLE = /[\u201C\u201D\u201E\u201F\u2033]/g;

/** NFKC, lowercase, straight quotes, letters/digits/space only, single spaces. */
export function normaliseForMatch(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  return text ? text.split(' ').filter(Boolean).length : 0;
}

/** Sentence-ish slices of the quote, normalised for substring matching. */
function quoteSlices(quote: string): string[] {
  return quote
    .split(/[.!?;:]+/)
    .map(normaliseForMatch)
    .filter(Boolean);
}

/**
 * True when a contiguous run of the quote appears in the chunk.
 *
 * Long quotes may match any clause of at least 8 words; a short quote only
 * counts when it is a full, sufficiently long substring of the chunk.
 */
export function quoteMatchesChunk(quote: string, chunkText: string): boolean {
  const normalisedQuote = normaliseForMatch(quote);
  const normalisedChunk = normaliseForMatch(chunkText);
  if (!normalisedQuote || !normalisedChunk) return false;

  if (wordCount(normalisedQuote) < MIN_WORDS) {
    return (
      normalisedQuote.length >= MIN_SHORT_QUOTE_CHARS &&
      normalisedChunk.includes(normalisedQuote)
    );
  }

  for (const slice of quoteSlices(quote)) {
    if (wordCount(slice) >= MIN_WORDS && normalisedChunk.includes(slice)) return true;
  }
  return normalisedChunk.includes(normalisedQuote);
}

function asChunk(source: AiRequest['sources'][number]): Chunk {
  return {
    id: source.chunkId,
    documentId: '',
    sectionId: null,
    ordinal: 0,
    text: source.text,
    page: source.page ?? null,
    charStart: null,
    charEnd: null,
  };
}

/**
 * Fill in page/section from the matched source where the model left them out.
 * A value the model supplied is never overwritten, and the chunk id stays the
 * source id so the citation remains verifiable.
 */
function enrichFromSource(
  citation: Citation,
  source: AiRequest['sources'][number],
): Citation {
  return {
    ...citation,
    chunkId: source.chunkId,
    page: citation.page ?? source.page ?? null,
    sectionTitle: citation.sectionTitle ?? source.sectionTitle ?? null,
  };
}

export function verifyCitations(
  citations: Citation[],
  sources: AiRequest['sources'],
  opts: { query?: string; repair?: boolean } = {},
): { kept: Citation[]; repaired: number; rejected: number } {
  const repair = opts.repair !== false;
  const byId = new Map((sources ?? []).map((source) => [source.chunkId, source]));
  const kept: Citation[] = [];
  let repaired = 0;
  let rejected = 0;

  for (const citation of Array.isArray(citations) ? citations : []) {
    if (kept.length >= MAX_CITATIONS) {
      rejected += 1;
      continue;
    }
    const source = byId.get(citation?.chunkId);
    if (!source) {
      rejected += 1;
      continue;
    }
    if (quoteMatchesChunk(citation.quote ?? '', source.text)) {
      kept.push(enrichFromSource(citation, source));
      continue;
    }
    if (!repair) {
      rejected += 1;
      continue;
    }
    const replacement = bestSupportingSentence(asChunk(source), opts.query ?? '');
    if (normaliseForMatch(replacement).length < MIN_SHORT_QUOTE_CHARS) {
      rejected += 1;
      continue;
    }
    kept.push(enrichFromSource({ ...citation, quote: replacement }, source));
    repaired += 1;
  }

  return { kept, repaired, rejected };
}

/** @deprecated Use `verifyCitations(...).kept`. */
export function filterValidCitations(
  citations: Citation[],
  sources: AiRequest['sources'],
): Citation[] {
  return verifyCitations(citations, sources).kept;
}
