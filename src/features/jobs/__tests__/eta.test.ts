/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { estimateEta, formatEtaRange, type EtaInput } from '@/features/jobs/eta';
import { STAGE_PRIOR_MS } from '@/features/jobs/priors';

const T0 = 1_700_000_000_000;

function input(overrides: Partial<EtaInput> = {}): EtaInput {
  return {
    now: T0,
    startedAt: T0,
    heartbeatAt: T0,
    order: ['map'],
    state: { map: { total: 10, done: 0 } },
    currentStage: 'map',
    inFlightElapsedMs: 0,
    samples: [],
    engine: 'remote',
    ...overrides,
  };
}

function samples(count: number, durationMs: number, stage: 'map' | 'reduce' = 'map') {
  return Array.from({ length: count }, (_, index) => ({
    stage,
    durationMs,
    at: T0 + index * 1_000,
  }));
}

describe('estimateEta', () => {
  it('cold start uses the engine prior and reports a low-confidence range', () => {
    const output = estimateEta(
      input({
        order: ['synth'],
        state: { synth: { total: 5, done: 0 } },
        currentStage: 'synth',
        engine: 'kokoro',
      }),
    );
    expect(output.remainingMs).toBe(5 * 60_000);
    expect(output.confidence).toBe('low');
    expect(output.lowMs).toBeGreaterThan(0);
    expect(output.lowMs as number).toBeLessThan(output.remainingMs as number);
    expect(output.highMs as number).toBeGreaterThan(output.remainingMs as number);
  });

  it('mid-run EWMA beats the prior and tightens as samples accumulate', () => {
    const three = estimateEta(
      input({
        state: { map: { total: 10, done: 6 } },
        samples: samples(3, 4_000),
      }),
    );
    expect(three.perUnitMs.map as number).toBeLessThan(STAGE_PRIOR_MS.map);
    expect(three.confidence).toBe('medium');

    const eight = estimateEta(
      input({
        state: { map: { total: 10, done: 6 } },
        samples: samples(8, 4_000),
      }),
    );
    expect(eight.confidence).toBe('high');
    const relThree = ((three.highMs as number) - (three.lowMs as number)) / (three.remainingMs as number);
    const relEight = ((eight.highMs as number) - (eight.lowMs as number)) / (eight.remainingMs as number);
    expect(relEight).toBeLessThan(relThree);
  });

  it('includes later stage priors after a stage transition', () => {
    const output = estimateEta(
      input({
        order: ['map', 'reduce', 'expand'],
        state: {
          map: { total: 2, done: 2 },
          reduce: { total: 2, done: 0 },
          expand: { total: 3, done: 0 },
        },
        currentStage: 'reduce',
        samples: samples(2, 4_000),
      }),
    );
    expect(output.remainingMs as number).toBeGreaterThan(0);
    expect(output.perUnitMs.map as number).toBeLessThan(STAGE_PRIOR_MS.map);
    expect(output.perUnitMs.reduce).toBe(STAGE_PRIOR_MS.reduce);
  });

  it('zeroes the estimate when every stage is complete', () => {
    const output = estimateEta(
      input({
        order: ['map', 'reduce', 'expand'],
        state: {
          map: { total: 2, done: 2 },
          reduce: { total: 2, done: 2 },
          expand: { total: 3, done: 3 },
        },
        currentStage: 'expand',
      }),
    );
    expect(output.remainingMs).toBe(0);
    expect(output.lowMs).toBe(0);
    expect(output.highMs).toBe(0);
    expect(output.confidence).toBe('high');
  });

  it('never shrinks the implied total by more than twenty percent in one update', () => {
    const output = estimateEta(
      input({
        now: T0 + 60_000,
        state: { map: { total: 10, done: 9 } },
        samples: samples(10, 1_000),
        previous: { at: T0, remainingMs: 600_000 },
      }),
    );
    expect(output.remainingMs as number).toBeGreaterThanOrEqual(420_000);
  });

  it('allows an upward revision after a slow run', () => {
    const output = estimateEta(
      input({
        now: T0 + 10_000,
        state: { map: { total: 20, done: 1 } },
        samples: samples(1, 20_000),
        previous: { at: T0, remainingMs: 30_000 },
      }),
    );
    expect(output.remainingMs as number).toBeGreaterThan(30_000);
  });

  it('is deterministic for the same now and flags a stale heartbeat', () => {
    const value = input({
      now: T0 + 5_000,
      heartbeatAt: T0 - 60_000,
      state: { map: { total: 4, done: 1 } },
    });
    expect(estimateEta(value)).toEqual(estimateEta(value));
    expect(estimateEta(value).stalled).toBe(true);
    expect(estimateEta(input()).stalled).toBe(false);
  });

  it('contains no clock or randomness', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/features/jobs/eta.ts'),
      'utf8',
    );
    const priors = fs.readFileSync(
      path.join(process.cwd(), 'src/features/jobs/priors.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/Date\.now/);
    expect(priors).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/Math\.random/);
  });
});

describe('formatEtaRange', () => {
  it('says it is estimating before the first unit finishes', () => {
    expect(
      formatEtaRange({ remainingMs: null, lowMs: null, highMs: null, confidence: 'none' }),
    ).toEqual({
      short: 'Estimating…',
      detail: 'The first passage has not finished yet.',
    });
  });

  it('never renders a point estimate', () => {
    const range = formatEtaRange({
      remainingMs: 600_000,
      lowMs: 480_000,
      highMs: 720_000,
      confidence: 'medium',
    });
    expect(range.short).toMatch(/^About \d+–\d+ min left$/);
  });

  it('uses hours past an hour and marks rough estimates in the detail only', () => {
    const range = formatEtaRange({
      remainingMs: 5_400_000,
      lowMs: 4_800_000,
      highMs: 6_000_000,
      confidence: 'low',
    });
    expect(range.short).toMatch(/^About \d+–\d+ hr left$/);
    expect(range.detail).toContain('Rough estimate');
  });

  it('handles under a minute', () => {
    expect(
      formatEtaRange({
        remainingMs: 20_000,
        lowMs: 10_000,
        highMs: 30_000,
        confidence: 'high',
      }).short,
    ).toBe('Less than a minute left');
  });
});
