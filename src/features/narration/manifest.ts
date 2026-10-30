/**
 * Pure rendition manifest math. No database, filesystem or clock reads: callers
 * pass every value in so the same functions can run in Jest and on device.
 */

/** Estimated spoken duration from character count (~14 chars per second). */
export function estimatedDurationMs(text: string): number {
  return Math.round((text.length / 14) * 1000);
}

/** Cumulative start offsets for a segment list. Missing durations use the text estimate. */
export function computeOffsets(segments: { durationMs: number | null; text: string }[]): number[] {
  let cursor = 0;
  return segments.map((segment) => {
    const start = cursor;
    cursor += segment.durationMs ?? estimatedDurationMs(segment.text);
    return start;
  });
}

/**
 * Map an absolute position onto a segment index and an offset inside it.
 * Positions past the final segment clamp to that segment and its full duration.
 */
export function locateInSegments(
  segments: { startMs: number; durationMs: number | null; text: string }[],
  positionMs: number,
): { index: number; offsetMs: number } {
  if (!segments.length) return { index: -1, offsetMs: 0 };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const durationMs = segment.durationMs ?? estimatedDurationMs(segment.text);
    const endMs = segment.startMs + durationMs;
    const isLast = index === segments.length - 1;

    if (positionMs < endMs || isLast) {
      const offsetMs = isLast && positionMs >= endMs ? durationMs : positionMs - segment.startMs;
      return { index, offsetMs: Math.max(0, Math.min(durationMs, offsetMs)) };
    }
  }

  const last = segments[segments.length - 1];
  const durationMs = last.durationMs ?? estimatedDurationMs(last.text);
  return { index: segments.length - 1, offsetMs: durationMs };
}

/** Absolute playback position for a segment start plus an intra-segment offset. */
export function positionOfSegment(startMs: number, offsetMs: number): number {
  return startMs + Math.max(0, offsetMs);
}

/** Chapter markers: one per section change whose first segment carries a title. */
export function sectionMarkers(
  segments: { startMs: number; title: string | null; sectionId: string | null }[],
): { startMs: number; title: string; sectionId: string | null }[] {
  const markers: { startMs: number; title: string; sectionId: string | null }[] = [];
  let previousSection: string | null | undefined;

  for (const segment of segments) {
    if (segment.sectionId !== previousSection) {
      if (segment.title !== null) {
        markers.push({
          startMs: segment.startMs,
          title: segment.title,
          sectionId: segment.sectionId,
        });
      }
      previousSection = segment.sectionId;
    }
  }
  return markers;
}

/**
 * The next playable segment after `index`, or null at the end / for an empty
 * list. Items without a `status` (pure manifest tests) are treated as playable;
 * queued/failed audio is skipped so playback never stalls on a missing file.
 */
export function nextSegment<T extends object>(
  segments: readonly T[],
  index: number,
): T | null {
  for (let candidate = index + 1; candidate < segments.length; candidate += 1) {
    const status = (segments[candidate] as { status?: string }).status;
    if (status === undefined || status === 'ready') return segments[candidate] ?? null;
  }
  return null;
}
