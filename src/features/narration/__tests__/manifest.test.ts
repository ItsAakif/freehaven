import {
  computeOffsets,
  estimatedDurationMs,
  locateInSegments,
  nextSegment,
  positionOfSegment,
  sectionMarkers,
} from '@/features/narration/manifest';

const segments = [
  { startMs: 0, durationMs: 1000, text: 'first' },
  { startMs: 1000, durationMs: 2000, text: 'second' },
  { startMs: 3000, durationMs: 500, text: 'third' },
];

describe('manifest', () => {
  it('estimates duration from character count', () => {
    expect(estimatedDurationMs('')).toBe(0);
    expect(estimatedDurationMs('x'.repeat(14))).toBe(1000);
    expect(estimatedDurationMs('x'.repeat(7))).toBe(500);
  });

  it('computes cumulative offsets, using estimates for missing durations', () => {
    expect(
      computeOffsets([
        { durationMs: 1000, text: 'a' },
        { durationMs: null, text: 'x'.repeat(14) },
        { durationMs: 250, text: 'c' },
      ]),
    ).toEqual([0, 1000, 2000]);
  });

  it('round-trips every segment boundary', () => {
    for (let index = 0; index < segments.length; index += 1) {
      expect(locateInSegments(segments, segments[index].startMs)).toEqual({ index, offsetMs: 0 });
    }
  });

  it('locates a mid-segment position', () => {
    expect(locateInSegments(segments, 1500)).toEqual({ index: 1, offsetMs: 500 });
  });

  it('clamps a position beyond the last segment to its full duration', () => {
    expect(locateInSegments(segments, 99_999)).toEqual({ index: 2, offsetMs: 500 });
    expect(locateInSegments(segments, 3500)).toEqual({ index: 2, offsetMs: 500 });
  });

  it('handles an empty segment list', () => {
    expect(locateInSegments([], 123)).toEqual({ index: -1, offsetMs: 0 });
    expect(nextSegment([], 0)).toBeNull();
  });

  it('returns the next segment by index', () => {
    expect(nextSegment(segments, 0)).toBe(segments[1]);
    expect(nextSegment(segments, 2)).toBeNull();
  });

  it('positions from a segment start and offset', () => {
    expect(positionOfSegment(1000, 300)).toBe(1300);
    expect(positionOfSegment(1000, -50)).toBe(1000);
  });

  it('emits section markers only on a section change with a title', () => {
    expect(
      sectionMarkers([
        { startMs: 0, title: 'One', sectionId: 's1' },
        { startMs: 1000, title: null, sectionId: 's1' },
        { startMs: 2000, title: 'Two', sectionId: 's2' },
        { startMs: 2500, title: 'Still two', sectionId: 's2' },
        { startMs: 3000, title: null, sectionId: 's3' },
        { startMs: 4000, title: 'Four', sectionId: 's4' },
      ]),
    ).toEqual([
      { startMs: 0, title: 'One', sectionId: 's1' },
      { startMs: 2000, title: 'Two', sectionId: 's2' },
      { startMs: 4000, title: 'Four', sectionId: 's4' },
    ]);
  });
});
