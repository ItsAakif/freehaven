import { coverFallback, coverInitial } from '@/design/cover';

// Every tile size Cover is rendered with today.
const TILES: [number, number][] = [
  [36, 52],
  [40, 58],
  [44, 64],
  [56, 82],
  [66, 96],
  [68, 100],
  [74, 108],
  [88, 120],
  [104, 150],
  [108, 156],
  [118, 172],
];

describe('coverFallback', () => {
  it.each(TILES)('scales the brand mark for a %ix%i tile without overflow', (width, height) => {
    const result = coverFallback(width, height);
    expect(result.kind).toBe('mark');
    if (result.kind !== 'mark') return;
    expect(result.size / height).toBeGreaterThanOrEqual(0.52);
    expect(result.size / height).toBeLessThanOrEqual(0.6);
    expect(result.size).toBeLessThan(width);
  });

  it('uses a single initial below the legible mark size', () => {
    expect(coverFallback(24, 32)).toEqual({ kind: 'initial', fontSize: 13 });
    expect(coverFallback(30, 40)).toEqual({ kind: 'initial', fontSize: 17 });
  });

  it('never returns a mark wider than the tile', () => {
    const result = coverFallback(20, 96);
    expect(result.kind).toBe('initial');
    if (result.kind !== 'initial') return;
    expect(result.fontSize).toBeLessThan(20);
  });

  it('copes with missing dimensions', () => {
    expect(coverFallback(Number.NaN, 0)).toEqual({ kind: 'initial', fontSize: 12 });
  });
});

describe('coverInitial', () => {
  it('takes the first visible character', () => {
    expect(coverInitial('The Psychology of Money')).toBe('T');
    expect(coverInitial('  the psychology of money')).toBe('T');
    expect(coverInitial('日本語')).toBe('日');
  });

  it('handles an empty title', () => {
    expect(coverInitial('   ')).toBe('\u00B7');
  });
});
