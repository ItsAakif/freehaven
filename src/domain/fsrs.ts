/**
 * FSRS-5 scheduler.
 *
 * Implements the published FSRS-5 formulas with the default 19-parameter weight
 * vector. Deterministic on purpose: no interval fuzzing, so scheduling is
 * reproducible and testable. Only the card's own fields and the review time are
 * inputs, so a review can be replayed exactly.
 *
 * Reference: Ye et al., "FSRS: A modern, efficient spaced repetition scheduler"
 * (open-spaced-repetition/free-spaced-repetition-scheduler).
 */

import type { Card, CardState, Grade } from './types';

export const DEFAULT_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
] as const;

const DECAY = -0.5;
const FACTOR = 19 / 81;
const DAY_MS = 86_400_000;
const MIN_STABILITY = 0.1;
const MAX_INTERVAL_DAYS = 36_500;
export const DESIRED_RETENTION = 0.9;

export type SchedulerInput = Pick<
  Card,
  'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'lastReviewAt'
>;
export type SchedulerOutput = {
  state: CardState;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  dueAt: number;
  elapsedDays: number;
  scheduledDays: number;
  retrievability: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * (Math.max(0, elapsedDays) / stability), DECAY);
}

export function initialDifficulty(grade: Grade, w: readonly number[] = DEFAULT_WEIGHTS): number {
  return clamp(w[4] - Math.exp(w[5] * (grade - 1)) + 1, 1, 10);
}

function nextDifficulty(d: number, grade: Grade, w: readonly number[]): number {
  const delta = d - w[6] * (grade - 3);
  const reverted = w[7] * initialDifficulty(4, w) + (1 - w[7]) * delta;
  return clamp(reverted, 1, 10);
}

export function intervalDays(stability: number, retention = DESIRED_RETENTION): number {
  const raw = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(raw), 1, MAX_INTERVAL_DAYS);
}

export function schedule(
  input: SchedulerInput,
  grade: Grade,
  now: number = Date.now(),
  w: readonly number[] = DEFAULT_WEIGHTS,
): SchedulerOutput {
  const isNew = input.state === 'new' || input.reps === 0 || input.stability <= 0;
  const elapsedDays = input.lastReviewAt
    ? Math.max(0, (now - input.lastReviewAt) / DAY_MS)
    : 0;
  const retrievable = isNew ? 0 : retrievability(elapsedDays, input.stability);

  let stability = input.stability;
  let difficulty = input.difficulty;
  let lapses = input.lapses;

  if (isNew) {
    stability = w[grade - 1];
    difficulty = initialDifficulty(grade, w);
  } else if (elapsedDays < 1) {
    // Same-day repeat: short-term stability update, difficulty unchanged in shape.
    stability = stability * Math.exp(w[17] * (grade - 3 + w[18]));
    difficulty = nextDifficulty(difficulty, grade, w);
  } else if (grade === 1) {
    const postLapse =
      w[11] *
      Math.pow(difficulty, -w[12]) *
      (Math.pow(stability + 1, w[13]) - 1) *
      Math.exp(w[14] * (1 - retrievable));
    stability = Math.min(postLapse, stability);
    difficulty = nextDifficulty(difficulty, grade, w);
    lapses += 1;
  } else {
    const hardPenalty = grade === 2 ? w[15] : 1;
    const easyBonus = grade === 4 ? w[16] : 1;
    stability =
      stability *
      (1 +
        Math.exp(w[8]) *
          (11 - difficulty) *
          Math.pow(stability, -w[9]) *
          (Math.exp(w[10] * (1 - retrievable)) - 1) *
          hardPenalty *
          easyBonus);
    difficulty = nextDifficulty(difficulty, grade, w);
  }

  stability = Math.max(MIN_STABILITY, stability);
  const scheduledDays = intervalDays(stability);
  const state: CardState =
    grade === 1 ? (input.state === 'new' ? 'learning' : 'relearning') : 'review';

  return {
    state,
    stability: Number(stability.toFixed(6)),
    difficulty: Number(difficulty.toFixed(6)),
    reps: input.reps + 1,
    lapses,
    dueAt: now + scheduledDays * DAY_MS,
    elapsedDays: Number(elapsedDays.toFixed(3)),
    scheduledDays,
    retrievability: Number(retrievable.toFixed(6)),
  };
}

/** Human label for the four grades, shared by the review UI. */
export const GRADE_LABELS: Record<Grade, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

export function isDue(card: Pick<Card, 'dueAt'>, now = Date.now()): boolean {
  return card.dueAt <= now;
}

/** New cards are due immediately; intervals are only produced by `schedule`. */
export function newCardSchedule(now = Date.now()): Pick<Card, 'state' | 'stability' | 'difficulty' | 'dueAt'> {
  return { state: 'new', stability: 0, difficulty: 0, dueAt: now };
}
