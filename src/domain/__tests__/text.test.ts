import {
  chunkText,
  estimateReadingMinutes,
  extractDefinitions,
  extractiveSummary,
  normalizeWhitespace,
  splitSentences,
  topKeywords,
  truncate,
  wordCount,
} from '@/domain/text';

describe('text utilities', () => {
  it('splits sentences without breaking abbreviations or decimals', () => {
    const text = 'Dr. Smith paid 3.50 euros. Then he left! Was that wise?';
    expect(splitSentences(text)).toEqual([
      'Dr. Smith paid 3.50 euros.',
      'Then he left!',
      'Was that wise?',
    ]);
  });

  it('normalises whitespace and counts words', () => {
    expect(normalizeWhitespace('a   b\n\n\nc')).toBe('a b\n\nc');
    expect(wordCount("one two three don't")).toBe(4);
    expect(estimateReadingMinutes(440)).toBe(2);
  });

  it('truncates on a word boundary', () => {
    expect(truncate('hello wonderful world', 12)).toBe('hello…');
  });

  it('chunks text with overlapping offsets inside bounds', () => {
    const paragraph = 'Sentence number one. '.repeat(120);
    const chunks = chunkText(paragraph, { targetChars: 500, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      expect(chunk.text.length).toBeGreaterThan(50);
    }
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[1].ordinal).toBe(1);
  });

  it('returns a deterministic extractive summary grounded in source sentences', () => {
    const text = [
      'Habits are automatic routines triggered by context.',
      'A cue precedes the routine and a reward follows it.',
      'Changing the cue is often easier than fighting the urge.',
      'Small environmental changes compound over months.',
      'Unrelated filler about weather and trains and distant hills.',
    ].join(' ');
    const summary = extractiveSummary(text, { maxSentences: 2 });
    expect(summary).toHaveLength(2);
    for (const sentence of summary) expect(text).toContain(sentence);
    expect(extractiveSummary(text, { maxSentences: 2 })).toEqual(summary);
  });

  it('extracts definition sentences and keywords', () => {
    const text = 'Attention is the selective allocation of processing resources. It matters.';
    const defs = extractDefinitions(text);
    expect(defs[0].term).toMatch(/Attention/);
    expect(topKeywords(text, 3)).toContain('attention');
  });
});
