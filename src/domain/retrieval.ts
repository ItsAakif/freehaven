/**
 * Lexical retrieval (BM25) over chunks.
 *
 * Deliberately dependency-free and synchronous: it runs on device, works
 * offline, and provides the evidence layer that every AI answer must cite.
 * Vector search can be added later behind the same `Retriever` interface.
 */

import { tokenize } from './text';
import type { Chunk, Citation } from './types';

export interface SearchHit {
  chunk: Chunk;
  score: number;
  matchedTerms: string[];
}

const K1 = 1.2;
const B = 0.75;

export function bm25(
  query: string,
  docs: { id: string; text: string }[],
  options: { limit?: number } = {},
): { id: string; score: number; matchedTerms: string[] }[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !docs.length) return [];
  const tokenized = docs.map((d) => tokenize(d.text));
  const lengths = tokenized.map((t) => t.length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const df = new Map<string, number>();
  for (const term of terms) {
    df.set(term, tokenized.reduce((acc, tokens) => acc + (tokens.includes(term) ? 1 : 0), 0));
  }
  const N = docs.length;
  const scored = docs.map((doc, i) => {
    const tokens = tokenized[i];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      matched.push(term);
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + K1 * (1 - B + (B * lengths[i]) / Math.max(1, avgLen));
      score += idf * ((f * (K1 + 1)) / denom);
    }
    return { id: doc.id, score, matchedTerms: matched };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 8);
}

export function searchChunks(query: string, chunks: Chunk[], limit = 6): SearchHit[] {
  const hits = bm25(
    query,
    chunks.map((c) => ({ id: c.id, text: c.text })),
    { limit },
  );
  const byId = new Map(chunks.map((c) => [c.id, c]));
  return hits
    .map((hit) => ({ chunk: byId.get(hit.id)!, score: hit.score, matchedTerms: hit.matchedTerms }))
    .filter((hit) => !!hit.chunk);
}

/** Best supporting sentence inside a chunk for a query (used for quotes). */
export function bestSupportingSentence(chunk: Chunk, query: string): string {
  const sentences = chunk.text.split(/(?<=[.!?])\s+/);
  const terms = new Set(tokenize(query));
  let best = sentences[0] ?? chunk.text;
  let bestScore = -1;
  for (const sentence of sentences) {
    const tokens = tokenize(sentence);
    const score = tokens.filter((t) => terms.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return best.trim();
}

export function toCitations(hits: SearchHit[], query: string, bookId: string): Citation[] {
  return hits.map((hit) => ({
    chunkId: hit.chunk.id,
    bookId,
    page: hit.chunk.page ?? null,
    sectionTitle: null,
    quote: bestSupportingSentence(hit.chunk, query),
  }));
}

/** Reject citations that were not actually retrieved for this answer. */
export function validateCitations(citations: Citation[], allowedChunkIds: Set<string>): boolean {
  return citations.every((c) => allowedChunkIds.has(c.chunkId));
}
