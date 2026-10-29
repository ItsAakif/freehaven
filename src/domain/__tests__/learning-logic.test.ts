import { bm25, searchChunks, toCitations, validateCitations } from '@/domain/retrieval';
import { generateCards, isValidMcq } from '@/domain/quiz';
import type { Chunk } from '@/domain/types';

const chunk = (id: string, text: string, page?: number): Chunk => ({
  id,
  documentId: 'doc',
  sectionId: 'sec',
  ordinal: 0,
  text,
  page: page ?? null,
  charStart: 0,
  charEnd: text.length,
});

const chunks = [
  chunk('a', 'Compound interest grows because returns are reinvested each year.', 1),
  chunk('b', 'The attention span of a goldfish is often cited, but the study is dubious.', 2),
  chunk('c', 'Sleep consolidates memory and improves recall of what you studied.', 3),
  chunk('d', 'Inflation erodes the purchasing power of money over time.', 4),
];

describe('lexical retrieval', () => {
  it('ranks the passage containing the query terms first', () => {
    const hits = bm25('compound interest reinvested', chunks.map((c) => ({ id: c.id, text: c.text })));
    expect(hits[0].id).toBe('a');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query', () => {
    expect(bm25('   ', chunks.map((c) => ({ id: c.id, text: c.text })))).toEqual([]);
  });

  it('produces citations with quotes drawn from the source', () => {
    const hits = searchChunks('memory sleep', chunks, 2);
    const citations = toCitations(hits, 'memory sleep', 'book');
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].chunkId).toBe('c');
    expect(chunks.find((c) => c.id === citations[0].chunkId)!.text).toContain(
      citations[0].quote.slice(0, 20),
    );
  });

  it('rejects citations that were not retrieved', () => {
    const citations = toCitations(searchChunks('sleep', chunks), 'sleep', 'book');
    expect(validateCitations(citations, new Set(['c']))).toBe(true);
    expect(validateCitations([{ ...citations[0], chunkId: 'ghost' }], new Set(['c']))).toBe(false);
  });
});

describe('card generation', () => {
  it('builds definition cards that keep their source chunk id', () => {
    const cards = generateCards(
      [chunk('a', 'Compound interest is the addition of interest to the principal sum of a loan or deposit.')],
      { maxCards: 3 },
    );
    expect(cards[0].kind).toBe('basic');
    expect(cards[0].front).toContain('Compound interest');
    expect(cards[0].sourceChunkId).toBe('a');
  });

  it('is deterministic for the same seed and input', () => {
    const input = chunks.map((c) => ({ id: c.id, text: c.text }));
    expect(generateCards(input, { seed: 11, maxCards: 6 })).toEqual(
      generateCards(input, { seed: 11, maxCards: 6 }),
    );
  });

  it('never returns more than the requested number of cards', () => {
    const cards = generateCards(chunks, { maxCards: 2 });
    expect(cards.length).toBeLessThanOrEqual(2);
  });

  it('validates multiple-choice answers against their options', () => {
    expect(isValidMcq(['a', 'b', 'c'], 'b')).toBe(true);
    expect(isValidMcq(['a', 'b'], 'z')).toBe(false);
    expect(isValidMcq(null, 'a')).toBe(false);
  });
});
