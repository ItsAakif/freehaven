import {
  segmentProgress,
  tokenizeTranscript,
  transcriptWordCount,
  wordIndexForProgress,
} from '@/features/narration/transcript';

describe('word-synced transcript', () => {
  it('starts on the first word', () => {
    expect(wordIndexForProgress('alpha beta gamma', 0)).toBe(0);
    expect(wordIndexForProgress('alpha beta gamma', -1)).toBe(0);
  });

  it('lands in the middle as playback advances', () => {
    expect(wordIndexForProgress('one two three four', 0.5)).toBe(2);
    expect(wordIndexForProgress('one two three four', 0.74)).toBe(2);
  });

  it('clamps to the last word at the end', () => {
    expect(wordIndexForProgress('alpha beta gamma', 1)).toBe(2);
    expect(wordIndexForProgress('alpha beta gamma', 4)).toBe(2);
  });

  it('keeps punctuation attached to its word', () => {
    const tokens = tokenizeTranscript('Hello, world! Goodbye.');
    expect(tokens.filter((token) => token.word).map((token) => token.text)).toEqual([
      'Hello,',
      'world!',
      'Goodbye.',
    ]);
    expect(transcriptWordCount('Hello, world! Goodbye.')).toBe(3);
    expect(wordIndexForProgress('Hello, world! Goodbye.', 0.5)).toBe(1);
  });

  it('returns -1 for empty text', () => {
    expect(transcriptWordCount('   \n ')).toBe(0);
    expect(wordIndexForProgress('', 0.5)).toBe(-1);
  });

  it('computes progress within a segment from its offsets', () => {
    const estimate = (value: string) => value.length * 100;
    expect(segmentProgress(1_500, 1_000, 2_000, 'abc', estimate)).toBe(0.25);
    expect(segmentProgress(500, 1_000, 2_000, 'abc', estimate)).toBe(0);
    expect(segmentProgress(1_000, 1_000, null, 'abcd', estimate)).toBe(0);
    expect(segmentProgress(1_300, 1_000, null, 'abc', estimate)).toBe(1);
  });
});
