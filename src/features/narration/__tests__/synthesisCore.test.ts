/** @jest-environment node */
import type { SpeechRequest } from '@/features/narration/cacheKey';
import { estimatedDurationMs } from '@/features/narration/manifest';
import type { NarrationEngine } from '@/features/narration/engines';
import {
  synthesiseRows,
  type SynthesisPatch,
  type SynthesisRow,
} from '@/features/narration/synthesisCore';

function row(overrides: Partial<SynthesisRow> = {}): SynthesisRow {
  return {
    ordinal: 0,
    text: 'hello world',
    speechKey: 'key-0',
    status: 'queued',
    filePath: null,
    format: null,
    durationMs: null,
    timingsJson: null,
    ...overrides,
  };
}

function requestFor(rowValue: SynthesisRow): SpeechRequest {
  return {
    text: rowValue.text,
    language: 'en',
    voice: 'voice',
    model: 'model',
    engine: 'remote',
    styleId: 'fireside',
    instructionHash: '',
    format: rowValue.format ?? 'wav',
  };
}

class FakeEngine implements NarrationEngine {
  readonly producesFiles: boolean;
  calls = 0;
  timings?: { text: string; startMs: number; endMs: number }[];

  constructor(
    readonly id: NarrationEngine['id'],
    producesFiles = true,
    private readonly failOnCall: number | null = null,
  ) {
    this.producesFiles = producesFiles;
  }

  get label() {
    return `Fake ${this.id}`;
  }

  async probe() {
    return { available: true as const };
  }

  async synthesize(request: SpeechRequest) {
    this.calls += 1;
    if (this.failOnCall === this.calls) throw new Error('synthesis failed');
    return {
      uri: `memory://${request.text.length}`,
      bytes: request.text.length,
      cached: false,
      format: request.format,
      ...(this.timings ? { timings: this.timings } : {}),
    };
  }
}

const deviceEngine: NarrationEngine = {
  id: 'device',
  label: 'Device',
  producesFiles: false,
  async probe() {
    return { available: true };
  },
  async synthesize() {
    throw new Error('device does not synthesize');
  },
};

describe('synthesiseRows', () => {
  it('skips ready rows and marks device rows ready without files', async () => {
    const events: { status: string; ordinal: number }[] = [];
    const patches: SynthesisPatch[] = [];
    const rows = [
      row({ ordinal: 0, status: 'ready', durationMs: 1_000 }),
      row({ ordinal: 1, text: 'device text', speechKey: 'key-1' }),
    ];

    const result = await synthesiseRows({
      rows,
      engine: deviceEngine,
      format: 'wav',
      requestFor,
      onSegment: (event) => {
        events.push({ status: event.status, ordinal: event.ordinal });
      },
      onDone: async (_row, patch) => {
        patches.push(patch);
      },
      onFailed: async () => {
        throw new Error('should not fail');
      },
    });

    expect(result).toEqual({ done: 2, failed: 0, cancelled: false });
    expect(events).toEqual([
      { status: 'skipped', ordinal: 0 },
      { status: 'start', ordinal: 1 },
      { status: 'done', ordinal: 1 },
    ]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: 'ready',
      speechKey: expect.any(String),
      filePath: null,
      format: null,
      durationMs: estimatedDurationMs('device text'),
      bytes: null,
    });
  });

  it('persists file assets and engine word timings', async () => {
    const engine = new FakeEngine('remote');
    engine.timings = [
      { text: 'first', startMs: 0, endMs: 250 },
      { text: 'second', startMs: 300, endMs: 700 },
    ];
    const patches: SynthesisPatch[] = [];

    const result = await synthesiseRows({
      rows: [row({ ordinal: 0, format: null })],
      engine,
      format: 'mp3',
      requestFor: (value) => ({ ...requestFor(value), format: 'mp3' }),
      onDone: async (_row, patch) => {
        patches.push(patch);
      },
      onFailed: async () => {
        throw new Error('should not fail');
      },
    });

    expect(result).toEqual({ done: 1, failed: 0, cancelled: false });
    expect(patches[0]).toMatchObject({
      status: 'ready',
      filePath: 'memory://11',
      format: 'mp3',
      bytes: 11,
      durationMs: estimatedDurationMs('hello world'),
      timingsJson: JSON.stringify(engine.timings),
    });
  });

  it('continues after a failure and reports it', async () => {
    const engine = new FakeEngine('remote', true, 1);
    const failures: { ordinal: number; error: string }[] = [];

    const result = await synthesiseRows({
      rows: [row({ ordinal: 0 }), row({ ordinal: 1, text: 'second', speechKey: 'key-1' })],
      engine,
      format: 'mp3',
      requestFor,
      onDone: async () => {},
      onFailed: async (value, error) => {
        failures.push({ ordinal: value.ordinal, error });
      },
    });

    expect(result).toEqual({ done: 1, failed: 1, cancelled: false });
    expect(failures).toEqual([{ ordinal: 0, error: 'synthesis failed' }]);
    expect(engine.calls).toBe(2);
  });

  it('stops before the next row when aborted', async () => {
    const controller = new AbortController();
    const engine = new FakeEngine('remote');
    const original = engine.synthesize.bind(engine);
    engine.synthesize = async (request) => {
      const asset = await original(request);
      controller.abort();
      return asset;
    };

    const result = await synthesiseRows({
      rows: [
        row({ ordinal: 0 }),
        row({ ordinal: 1, text: 'second', speechKey: 'key-1' }),
        row({ ordinal: 2, text: 'third', speechKey: 'key-2' }),
      ],
      engine,
      format: 'mp3',
      requestFor,
      onDone: async () => {},
      onFailed: async () => {},
      signal: controller.signal,
    });

    expect(result).toEqual({ done: 1, failed: 0, cancelled: true });
    expect(engine.calls).toBe(1);
  });

  it('emits progress after every row and once at the end', async () => {
    const progress: { done: number; total: number; failed: number }[] = [];

    const result = await synthesiseRows({
      rows: [
        row({ ordinal: 0, status: 'ready' }),
        row({ ordinal: 1, speechKey: 'key-1' }),
        row({ ordinal: 2, text: 'third', speechKey: 'key-2' }),
      ],
      engine: deviceEngine,
      format: 'wav',
      requestFor,
      onDone: async () => {},
      onFailed: async () => {},
      onProgress: (value) => {
        progress.push(value);
      },
    });

    expect(result).toEqual({ done: 3, failed: 0, cancelled: false });
    expect(progress).toEqual([
      { done: 1, total: 3, failed: 0 },
      { done: 2, total: 3, failed: 0 },
      { done: 3, total: 3, failed: 0 },
      { done: 3, total: 3, failed: 0 },
    ]);
  });
});
