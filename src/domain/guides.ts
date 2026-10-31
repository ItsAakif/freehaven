/**
 * Full Guide domain types and pure status helpers.
 *
 * Pure: no Expo, React or SQLite imports. Repositories and screens share these
 * values; the only clock input is `now`, passed explicitly.
 */

import type { NarrationStyleId, RenditionEngine } from './narration';

export type GuideStatus =
  | 'draft'
  | 'ready'
  | 'generating'
  | 'partial'
  | 'generated'
  | 'failed';

export type GuideChapterStatus =
  | 'pending'
  | 'summarising'
  | 'scripted'
  | 'synthesising'
  | 'ready'
  | 'failed';

export type GuideSegmentStatus = 'queued' | 'ready' | 'failed';

export interface Guide {
  id: string;
  bookId: string;
  planId: string | null;
  title: string;
  styleId: NarrationStyleId;
  language: string;
  engine: RenditionEngine;
  voice: string | null;
  model: string | null;
  wordsPerChapter: number;
  chaptersPerDay: number;
  status: GuideStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GuideChapter {
  id: string;
  guideId: string;
  ordinal: number;
  title: string;
  startPage: number | null;
  endPage: number | null;
  sectionIds: string[];
  summaryMd: string | null;
  wordCount: number;
  provider: string | null;
  model: string | null;
  status: GuideChapterStatus;
  error: string | null;
  audioPath: string | null;
  durationMs: number | null;
  timingsJson: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface GuideChapterSegment {
  id: string;
  guideChapterId: string;
  ordinal: number;
  text: string;
  speechKey: string | null;
  filePath: string | null;
  format: 'mp3' | 'wav' | null;
  durationMs: number | null;
  bytes: number | null;
  startMs: number;
  timingsJson: string | null;
  status: GuideSegmentStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewGuideChapter {
  title: string;
  startPage: number | null;
  endPage: number | null;
  sectionIds: string[];
}

/** Pure status recompute after a generation run. */
export function guideStatusFor(chapters: Pick<GuideChapter, 'status'>[]): GuideStatus {
  const statuses = chapters.map((chapter) => chapter.status);
  if (statuses.length > 0 && statuses.every((status) => status === 'ready')) {
    return 'generated';
  }
  if (statuses.some((status) => status === 'ready')) return 'partial';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  return 'ready';
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Consecutive-day streak from local `YYYY-MM-DD` keys. The streak may start
 * today or, when today has no activity yet, yesterday — the same rule as
 * `reviewStats` in the learning repository.
 */
export function streakFromDayKeys(days: readonly string[], now: number): number {
  const daySet = new Set(days);
  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  for (let index = 0; index < 60; index += 1) {
    const key = dayKey(cursor);
    if (!daySet.has(key)) {
      if (index === 0) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
