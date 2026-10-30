import {
  LENGTH_PRESETS,
  estimateSpokenMs,
  wordsForMinutes,
} from '@/features/narration/lengths';

describe('narration lengths', () => {
  it('maps every length to its word budget', () => {
    expect(wordsForMinutes('5')).toBe(725);
    expect(wordsForMinutes('15')).toBe(2175);
    expect(wordsForMinutes('25')).toBe(3625);
  });

  it('labels every preset with its minutes', () => {
    expect(LENGTH_PRESETS).toHaveLength(3);
    for (const preset of LENGTH_PRESETS) {
      expect(preset.label).toContain(String(preset.minutes));
      expect(preset.words).toBe(wordsForMinutes(preset.id));
    }
  });

  it('estimates spoken time at 145 words per minute', () => {
    expect(estimateSpokenMs(145)).toBe(60_000);
    expect(estimateSpokenMs(0)).toBe(0);
    expect(estimateSpokenMs(725)).toBe(300_000);
    expect(estimateSpokenMs(145, 290)).toBe(30_000);
  });
});
