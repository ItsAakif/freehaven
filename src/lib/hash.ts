/**
 * Shared FNV-1a 32-bit hash.
 *
 * Pure module: no Expo, no React, no clock. Used for cache keys and checkpoint
 * input keys so two modules never grow their own subtly different hash.
 */

/** FNV-1a 32-bit over UTF-16 code units, as 8 lowercase hex characters. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
