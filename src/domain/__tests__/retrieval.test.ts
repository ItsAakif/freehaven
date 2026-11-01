/** @jest-environment node */
import { bm25, selectTerms } from '@/domain/retrieval';

describe('selectTerms', () => {
  it('drops terms that occur in too many documents', () => {
    const df = new Map([
      ['book', 9],
      ['photosynthesis', 1],
      ['author', 4],
    ]);
    expect(selectTerms(['book', 'photosynthesis', 'author'], df, 10)).toEqual([
      'photosynthesis',
      'author',
    ]);
  });

  it('falls back to the lowest-df terms when every term is boilerplate', () => {
    const df = new Map([
      ['book', 10],
      ['text', 10],
      ['main', 8],
    ]);
    expect(selectTerms(['book', 'text', 'main'], df, 10)).toEqual(['main']);
    expect(
      selectTerms(
        ['book', 'text'],
        new Map([
          ['book', 10],
          ['text', 10],
        ]),
        10,
      ),
    ).toEqual(['book', 'text']);
  });
});

describe('bm25 with document-frequency filtering', () => {
  // "book" is boilerplate: every chunk contains it. Only one chunk is about risk.
  const docs = Array.from({ length: 10 }, (_, index) => ({
    id: `d${index}`,
    text:
      index === 3
        ? 'Risk is the probability of loss in every investment decision, and this book treats it carefully.'
        : `This book covers chapter ${index} with history, examples and patient practice.`,
  }));

  it('ranks the distinctive chunk first and ignores the boilerplate term', () => {
    const hits = bm25('book risk', docs, { limit: 6 });
    expect(hits[0].id).toBe('d3');
    expect(hits[0].matchedTerms).toEqual(['risk']);
    expect(hits.every((hit) => !hit.matchedTerms.includes('book'))).toBe(true);
  });

  it('still returns matches for an all-boilerplate query', () => {
    const hits = bm25('book', docs, { limit: 6 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matchedTerms).toEqual(['book']);
  });
});
