import {
  filterValidCitations,
  normaliseForMatch,
  quoteMatchesChunk,
  verifyCitations,
} from '@/ai/citations';
import type { Citation } from '@/domain/types';
import type { AiRequest } from '@/ai/types';

const CHUNK =
  'Compound interest is the addition of interest to the principal sum of a loan or deposit. ' +
  'It is the result of reinvesting interest rather than paying it out. ' +
  'This mechanism makes the principal grow faster than simple interest would.';

const sources: AiRequest['sources'] = [{ chunkId: 'c1', text: CHUNK, page: 4 }];

function citation(quote: string, chunkId = 'c1'): Citation {
  return { chunkId, bookId: 'b1', quote };
}

describe('normaliseForMatch', () => {
  it('folds case, quotes, punctuation and whitespace', () => {
    expect(normaliseForMatch('  Hello,\n  World!  ')).toBe('hello world');
    expect(normaliseForMatch('“Curly” ‘quotes’')).toBe('curly quotes');
    expect(normaliseForMatch('CAFÉ')).toBe('café');
  });

  it('preserves non-Latin scripts', () => {
    expect(normaliseForMatch('日本語の文章')).toBe('日本語の文章');
  });
});

describe('quoteMatchesChunk', () => {
  it('accepts an exact quote', () => {
    expect(quoteMatchesChunk('It is the result of reinvesting interest rather than paying it out.', CHUNK)).toBe(
      true,
    );
  });

  it('accepts whitespace and curly-quote variants', () => {
    expect(
      quoteMatchesChunk(
        'Compound   interest is the addition\nof interest to the principal sum of a loan or deposit.',
        CHUNK,
      ),
    ).toBe(true);
    expect(
      quoteMatchesChunk(
        '“Compound interest is the addition of interest to the principal sum of a loan or deposit.”',
        CHUNK,
      ),
    ).toBe(true);
  });

  it('accepts a quote spanning two sentences', () => {
    expect(
      quoteMatchesChunk(
        'Compound interest is the addition of interest to the principal sum of a loan or deposit. It is the result of reinvesting interest rather than paying it out.',
        CHUNK,
      ),
    ).toBe(true);
  });

  it('rejects a fabricated sentence', () => {
    expect(
      quoteMatchesChunk('Bananas are an excellent source of potassium and taste wonderful.', CHUNK),
    ).toBe(false);
  });

  it('rejects a short quote that is not a full enough chunk substring', () => {
    expect(quoteMatchesChunk('cat sat on', 'The cat sat on the mat.')).toBe(false);
    expect(quoteMatchesChunk('principal sum', CHUNK)).toBe(false);
  });
});

describe('verifyCitations', () => {
  it('keeps an exact quote as-is', () => {
    const quote = 'It is the result of reinvesting interest rather than paying it out.';
    const result = verifyCitations([citation(quote)], sources);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].quote).toBe(quote);
    expect(result.repaired).toBe(0);
    expect(result.rejected).toBe(0);
  });

  it('repairs a fabricated quote to a sentence in the chunk', () => {
    const result = verifyCitations(
      [citation('Bananas are an excellent source of potassium and taste wonderful.')],
      sources,
      { query: 'compound interest' },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.repaired).toBe(1);
    expect(result.rejected).toBe(0);
    expect(CHUNK).toContain(result.kept[0].quote);
  });

  it('rejects an unknown chunk id', () => {
    const result = verifyCitations([citation(CHUNK, 'ghost')], sources);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });

  it('truncates to six kept citations', () => {
    const manySources = Array.from({ length: 8 }, (_, index) => ({
      chunkId: `c${index + 1}`,
      text: CHUNK,
    }));
    const many = manySources.map((source) => citation(CHUNK, source.chunkId));
    const result = verifyCitations(many, manySources);
    expect(result.kept).toHaveLength(6);
    expect(result.kept.map((item) => item.chunkId)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
    ]);
    expect(result.rejected).toBe(2);
  });

  it('drops instead of repairing when repair is false', () => {
    const result = verifyCitations(
      [citation('Bananas are an excellent source of potassium and taste wonderful.')],
      sources,
      { repair: false, query: 'compound interest' },
    );
    expect(result.kept).toHaveLength(0);
    expect(result.repaired).toBe(0);
    expect(result.rejected).toBe(1);
  });

  it('rejects a short quote that is not a full chunk substring', () => {
    const result = verifyCitations([citation('principal sum')], sources, { repair: false });
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });

  it('never throws on empty sources', () => {
    expect(() => verifyCitations([citation(CHUNK)], [])).not.toThrow();
    expect(verifyCitations([citation(CHUNK)], [])).toMatchObject({
      kept: [],
      repaired: 0,
      rejected: 1,
    });
    expect(() => verifyCitations([], [])).not.toThrow();
  });

  it('keeps the deprecated wrapper working', () => {
    const quote = 'It is the result of reinvesting interest rather than paying it out.';
    expect(filterValidCitations([citation(quote)], sources)).toHaveLength(1);
  });
});
