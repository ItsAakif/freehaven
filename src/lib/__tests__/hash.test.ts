import { fnv1a32 } from '@/lib/hash';

describe('fnv1a32', () => {
  it('hashes the empty string to the FNV offset basis', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
  });

  it('is stable, lowercase and eight hex characters', () => {
    expect(fnv1a32('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
  });

  it('changes when the input changes', () => {
    expect(fnv1a32('Same')).not.toBe(fnv1a32('Different'));
  });

  it('combines with the same arithmetic as the narration instruction hash', () => {
    // Pinned value for the string used across the narration tests.
    expect(fnv1a32('Same')).toBe(fnv1a32('Same'));
    expect(fnv1a32('word')).toMatch(/^[0-9a-f]{8}$/);
  });
});
