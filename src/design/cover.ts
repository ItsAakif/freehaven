/**
 * Sizing for the missing-cover fallback.
 *
 * The brand mark takes 56% of the tile height so it stays centred and snug
 * without touching the frame. Tiles too short for a legible mark fall back to
 * a single centred initial instead of wrapping the title.
 */

export const COVER_MARK_RATIO = 0.56;
export const COVER_MARK_MIN_TILE_HEIGHT = 44;
export const COVER_MARK_MIN_SIZE = 20;

export type CoverFallback =
  | { kind: 'mark'; size: number }
  | { kind: 'initial'; fontSize: number };

export function coverFallback(width: number, height: number): CoverFallback {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const size = Math.round(Math.min(safeHeight * COVER_MARK_RATIO, safeWidth * 0.8));
  if (safeHeight < COVER_MARK_MIN_TILE_HEIGHT || size < COVER_MARK_MIN_SIZE) {
    const fontSize = Math.max(
      12,
      Math.round(Math.min(safeHeight * 0.42, safeWidth * 0.6)),
    );
    return { kind: 'initial', fontSize };
  }
  return { kind: 'mark', size };
}

/** First visible character of the title, used only on very small tiles. */
export function coverInitial(title: string): string {
  const trimmed = (title ?? '').trim();
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : '\u00B7';
}
