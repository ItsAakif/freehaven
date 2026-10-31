import {
  isBackgroundGenerationSupported,
  startBackgroundGeneration,
  stopBackgroundGeneration,
  updateBackgroundGeneration,
} from '../index';

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: jest.fn(() => null),
}));

describe('background generation module without a native registration', () => {
  it('reports unsupported and treats every foreground call as a no-op', async () => {
    expect(isBackgroundGenerationSupported()).toBe(false);

    await expect(
      startBackgroundGeneration({ title: 'Generating', text: 'Preparing...' }),
    ).resolves.toBeUndefined();
    await expect(
      updateBackgroundGeneration({ text: 'Recording audio', progress: 25 }),
    ).resolves.toBeUndefined();
    await expect(stopBackgroundGeneration()).resolves.toBeUndefined();
  });
});
