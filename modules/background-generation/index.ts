/**
 * Local Expo module: Android background generation.
 *
 * The native side is a foreground service (`dataSync`) plus a partial wake
 * lock. It keeps the existing JS context alive while a generation job runs, so
 * the runner in `src/features/jobs` keeps making progress when the app is in
 * the background.
 *
 * `requireOptionalNativeModule` returns null on web, iOS and Expo Go, so none
 * of these exports can throw there.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

type BackgroundGenerationNativeModule = {
  /** Starts the foreground service. Text is shown on the first notification. */
  start(title: string, text: string): Promise<boolean>;
  /**
   * Updates the ongoing notification. `progress` is a percentage in 0..100;
   * a negative value switches the bar to indeterminate.
   */
  update(text: string, progress: number): Promise<boolean>;
  stop(): Promise<boolean>;
};

export type BackgroundGenerationStartInput = {
  title: string;
  text: string;
};

export type BackgroundGenerationUpdateInput = {
  text: string;
  /** Percentage in 0..100, or a negative value for indeterminate. */
  progress: number;
};

let nativeModule: BackgroundGenerationNativeModule | null = null;
try {
  nativeModule = requireOptionalNativeModule<BackgroundGenerationNativeModule>('BackgroundGeneration');
} catch {
  // Missing registration is expected on web, iOS and Expo Go.
  nativeModule = null;
}

export function isBackgroundGenerationSupported(): boolean {
  return nativeModule != null;
}

export async function startBackgroundGeneration(
  input: BackgroundGenerationStartInput,
): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.start(input.title, input.text);
  } catch {
    // The OS may refuse the foreground service; generation still runs.
  }
}

export async function updateBackgroundGeneration(
  input: BackgroundGenerationUpdateInput,
): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.update(input.text, input.progress);
  } catch {
    // A stale notification must not fail the job.
  }
}

export async function stopBackgroundGeneration(): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.stop();
  } catch {
    // Best effort: the service may already be gone.
  }
}
