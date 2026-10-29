import {
  DEFAULT_WEIGHTS,
  intervalDays,
  retrievability,
  schedule,
  type SchedulerInput,
} from '@/domain/fsrs';

const NOW = Date.UTC(2026, 0, 1, 12);
const fresh: SchedulerInput = {
  state: 'new',
  stability: 0,
  difficulty: 0,
  reps: 0,
  lapses: 0,
  lastReviewAt: null,
};

describe('FSRS scheduler', () => {
  it('is deterministic for identical inputs', () => {
    const a = schedule(fresh, 3, NOW);
    const b = schedule(fresh, 3, NOW);
    expect(a).toEqual(b);
  });

  it('uses the initial stability weight for a new card', () => {
    const result = schedule(fresh, 3, NOW);
    expect(result.stability).toBeCloseTo(DEFAULT_WEIGHTS[2], 4);
    expect(result.state).toBe('review');
    expect(result.reps).toBe(1);
    expect(result.dueAt).toBe(NOW + result.scheduledDays * 86_400_000);
  });

  it('orders intervals Hard < Good < Easy on the same review', () => {
    const base: SchedulerInput = {
      state: 'review',
      stability: 10,
      difficulty: 5,
      reps: 3,
      lapses: 0,
      lastReviewAt: NOW - 10 * 86_400_000,
    };
    const hard = schedule(base, 2, NOW).scheduledDays;
    const good = schedule(base, 3, NOW).scheduledDays;
    const easy = schedule(base, 4, NOW).scheduledDays;
    expect(hard).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
  });

  it('increments lapses and does not increase stability on Again', () => {
    const base: SchedulerInput = {
      state: 'review',
      stability: 20,
      difficulty: 4,
      reps: 5,
      lapses: 1,
      lastReviewAt: NOW - 30 * 86_400_000,
    };
    const result = schedule(base, 1, NOW);
    expect(result.lapses).toBe(2);
    expect(result.stability).toBeLessThanOrEqual(base.stability);
    expect(result.state).toBe('relearning');
    expect(result.scheduledDays).toBeGreaterThanOrEqual(1);
  });

  it('is monotonic in elapsed time for a fixed stability', () => {
    expect(retrievability(0, 10)).toBeCloseTo(1, 5);
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 2);
    expect(retrievability(60, 10)).toBeLessThan(retrievability(10, 10));
  });

  it('handles same-day repeats with the short-term weights', () => {
    const base: SchedulerInput = {
      state: 'review',
      stability: 5,
      difficulty: 5,
      reps: 2,
      lapses: 0,
      lastReviewAt: NOW - 3_600_000,
    };
    const again = schedule(base, 1, NOW);
    const good = schedule(base, 3, NOW);
    expect(again.stability).toBeLessThan(good.stability);
    expect(intervalDays(1)).toBe(1);
  });

  it('never schedules beyond the maximum interval', () => {
    expect(intervalDays(1e9)).toBeLessThanOrEqual(36_500);
  });
});
