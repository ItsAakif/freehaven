import { encodeWav } from '@/features/narration/wav';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function int16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(offset, true);
}

describe('WAV encoder', () => {
  it('writes a valid mono 16-bit PCM RIFF header', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const bytes = encodeWav(samples, 24_000);
    expect(bytes.length).toBe(44 + samples.length * 2);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(uint32(bytes, 40)).toBe(samples.length * 2);
    expect(uint32(bytes, 24)).toBe(24_000);
    expect(uint32(bytes, 4)).toBe(36 + samples.length * 2);
  });

  it('clamps out-of-range samples instead of overflowing', () => {
    const bytes = encodeWav(new Float32Array([2, -2]), 16_000);
    expect(int16(bytes, 44)).toBe(32_767);
    expect(int16(bytes, 46)).toBe(-32_768);
  });

  it('returns an empty data chunk for no samples', () => {
    const bytes = encodeWav(new Float32Array(0), 24_000);
    expect(bytes.length).toBe(44);
    expect(uint32(bytes, 40)).toBe(0);
  });
});
