/** @jest-environment node */
import * as nativeModule from '../../../../modules/background-generation';
import {
  foregroundProgressText,
  getForegroundBridge,
  setForegroundBridgeForTests,
} from '@/features/jobs/foreground';

jest.mock('../../../../modules/background-generation', () => ({
  isBackgroundGenerationSupported: () => false,
  startBackgroundGeneration: jest.fn(async () => undefined),
  updateBackgroundGeneration: jest.fn(async () => undefined),
  stopBackgroundGeneration: jest.fn(async () => undefined),
}));

describe('foreground generation bridge', () => {
  afterEach(() => {
    setForegroundBridgeForTests(null);
  });

  it('no-ops when the native module is missing', async () => {
    const bridge = getForegroundBridge();

    await expect(bridge.start({ title: 'Generating', text: 'Preparing...' })).resolves.toBeUndefined();
    await expect(
      bridge.update({ text: 'Recording audio - Estimating...', progress: -1 }),
    ).resolves.toBeUndefined();
    await expect(bridge.stop()).resolves.toBeUndefined();

    expect(nativeModule.startBackgroundGeneration).not.toHaveBeenCalled();
    expect(nativeModule.updateBackgroundGeneration).not.toHaveBeenCalled();
    expect(nativeModule.stopBackgroundGeneration).not.toHaveBeenCalled();
  });

  it('uses an injected bridge and can be reset', async () => {
    const calls: string[] = [];
    setForegroundBridgeForTests({
      async start() {
        calls.push('start');
      },
      async update() {
        calls.push('update');
      },
      async stop() {
        calls.push('stop');
      },
    });

    const bridge = getForegroundBridge();
    await bridge.start({ title: 'Generating', text: 'Preparing...' });
    await bridge.update({ text: 'Recording audio - Estimating...', progress: 20 });
    await bridge.stop();
    expect(calls).toEqual(['start', 'update', 'stop']);

    setForegroundBridgeForTests(null);
    expect(getForegroundBridge()).not.toBe(bridge);
  });

  it('builds notification text from the stage and the ETA range', () => {
    const text = foregroundProgressText({
      stage: 'synth',
      eta: {
        remainingMs: 12 * 60_000,
        lowMs: 8 * 60_000,
        highMs: 20 * 60_000,
        confidence: 'medium',
      },
    });

    expect(text).toContain('Recording audio');
    expect(text).toMatch(/About \d+.\d+ min left/);
  });

  it('reports the preparing label before a stage exists', () => {
    const text = foregroundProgressText({
      stage: null,
      eta: { remainingMs: null, lowMs: null, highMs: null, confidence: 'none' },
    });

    expect(text).toContain('Preparing - Estimating');
  });
});
