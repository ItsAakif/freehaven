/**
 * Pure RIFF/WAV encoder: 16-bit PCM, mono.
 *
 * Kept free of Expo/filesystem so the adapter can write the bytes and Jest can
 * assert the container without a device.
 */

const HEADER_BYTES = 44;
const DEFAULT_PEAK = 0.95;

/**
 * Scale samples so the loudest absolute value equals `target` (default 0.95).
 * Pure: the input array is never mutated. Silence and empty input return a copy
 * unchanged so callers can encode immediately.
 */
export function normalisePeak(
  samples: Float32Array,
  target = DEFAULT_PEAK,
): Float32Array {
  const out = new Float32Array(samples);
  if (!samples.length) return out;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
  }
  if (!Number.isFinite(peak) || peak <= 0) return out;
  const safeTarget = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : DEFAULT_PEAK;
  if (safeTarget <= 0) return out;
  const gain = safeTarget / peak;
  for (let i = 0; i < out.length; i += 1) out[i] *= gain;
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 24_000;
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate = rate * channels * bytesPerSample
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(value), true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
