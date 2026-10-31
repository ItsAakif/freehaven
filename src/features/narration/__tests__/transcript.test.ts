import {
  parseSpeechTimings,
  segmentProgress,
  timingIndexForElapsed,
  tokenizeTranscript,
  transcriptWordCount,
  wordIndexForProgress,
} from '@/features/narration/transcript';
import type { SpeechTiming } from '@/domain/narration';

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

  const timings: SpeechTiming[] = [
    { text: 'one', startMs: 0, endMs: 400 },
    { text: 'two', startMs: 450, endMs: 900 },
    { text: 'three', startMs: 950, endMs: 1400 },
  ];

  it('selects the active timing before, between and after words', () => {
    expect(timingIndexForElapsed(timings, -50)).toBe(0);
    expect(timingIndexForElapsed(timings, 0)).toBe(0);
    expect(timingIndexForElapsed(timings, 425)).toBe(0);
    expect(timingIndexForElapsed(timings, 450)).toBe(1);
    expect(timingIndexForElapsed(timings, 1_500)).toBe(2);
    expect(timingIndexForElapsed([], 500)).toBe(-1);
  });

  it('parses stored timings and rejects garbage', () => {
    expect(parseSpeechTimings(JSON.stringify(timings))).toEqual(timings);
    expect(parseSpeechTimings(null)).toEqual([]);
    expect(parseSpeechTimings('')).toEqual([]);
    expect(parseSpeechTimings('not json')).toEqual([]);
    expect(parseSpeechTimings('{"text":"one"}')).toEqual([]);
    expect(
      parseSpeechTimings('[{"text":"one","startMs":0,"endMs":1},{"text":42}]'),
    ).toEqual([{ text: 'one', startMs: 0, endMs: 1 }]);
  });
});
