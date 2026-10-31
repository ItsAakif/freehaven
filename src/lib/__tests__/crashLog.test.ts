import { handleGlobalError, installGlobalErrorHandler } from '@/lib/crashLog';

jest.mock('expo-file-system', () => {
  throw new Error('ExpoFileSystem native module is missing');
});

describe('global crash logging', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('never throws when the filesystem import fails', async () => {
    const loadFileSystem = jest.fn(async (): Promise<never> => {
      throw new Error('ExpoFileSystem native module is missing');
    });

    await expect(
      handleGlobalError(new Error('startup failed'), loadFileSystem),
    ).resolves.toBeUndefined();
    expect(loadFileSystem).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it('installs a global handler that absorbs a failing filesystem import', async () => {
    const setGlobalHandler = jest.fn();
    installGlobalErrorHandler({ setGlobalHandler });

    const handler = setGlobalHandler.mock.calls[0]?.[0] as ((error: Error) => void) | undefined;
    expect(handler).toBeDefined();
    expect(() => handler?.(new Error('render failed'))).not.toThrow();

    // Let the fire-and-forget handler finish; it must not reject either.
    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalled();
  });
});
