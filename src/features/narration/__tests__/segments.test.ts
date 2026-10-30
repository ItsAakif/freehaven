import { maxCharsForEngine, planSpeechSegments } from '@/features/narration/segments';

describe('speech segmentation', () => {
  it('uses the per-engine character budgets', () => {
    expect(maxCharsForEngine('device')).toBe(480);
    expect(maxCharsForEngine('remote')).toBe(3_800);
    expect(maxCharsForEngine('piper')).toBe(800);
    expect(maxCharsForEngine('kokoro')).toBe(600);
  });

  it('hard-splits a 500-character sentence into five 100-character pieces', () => {
    const pieces = planSpeechSegments('a'.repeat(500), 100);
    expect(pieces).toHaveLength(5);
    expect(pieces.every((piece) => piece.text.length <= 100)).toBe(true);
    expect(pieces.every((piece) => piece.text.length > 0)).toBe(true);
    expect(pieces.map((piece) => piece.text).join('')).toBe('a'.repeat(500));
    expect(pieces[4].text).toBe('a'.repeat(100));
  });

  it('splits a long section without truncating any sentence', () => {
    const sentence = 'This sentence carries a distinct opening phrase for the check.';
    const text = Array.from({ length: 200 }, (_, index) => `${sentence} Item ${index}.`).join(' ');
    expect(text.length).toBeGreaterThan(12_000);

    const pieces = planSpeechSegments(text, 480);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.text.length <= 480)).toBe(true);
    expect(pieces.every((piece) => piece.text.trim().length > 0)).toBe(true);

    const joined = pieces.map((piece) => piece.text).join(' ');
    for (const sentenceText of text.match(/[^.!?]+[.!?]+/g) ?? []) {
      expect(joined).toContain(sentenceText.slice(0, 20));
    }
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(planSpeechSegments('', 480)).toEqual([]);
    expect(planSpeechSegments('   \n\t ', 480)).toEqual([]);
  });

  it('segments CJK prose without one giant piece', () => {
    const sentence = '今日は晴れです。';
    const text = sentence.repeat(120);
    expect(text.length).toBeGreaterThan(480);
    const pieces = planSpeechSegments(text, 480);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.text.length <= 480)).toBe(true);
    expect(pieces.every((piece) => piece.text.trim().length > 0)).toBe(true);
    expect(pieces.map((piece) => piece.text).join('').replace(/ /g, '')).toBe(text);
  });

  it('preserves order and char offsets are monotonic', () => {
    const pieces = planSpeechSegments('First one. Second two. Third three.', 20);
    expect(pieces.map((piece) => piece.text)).toEqual([
      'First one.',
      'Second two.',
      'Third three.',
    ]);
    for (let index = 1; index < pieces.length; index += 1) {
      expect(pieces[index].charStart).toBeGreaterThanOrEqual(pieces[index - 1].charStart);
    }
  });
});
