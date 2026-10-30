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

import { requireOptionalNativeModule } from 'expo';

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

const nativeModule =
  requireOptionalNativeModule<BackgroundGenerationNativeModule>('BackgroundGeneration');

export function isBackgroundGenerationSupported(): boolean {
  return nativeModule != null;
}

export async function startBackgroundGeneration(
  input: BackgroundGenerationStartInput,
): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.start(input.title, input.text);
}

export async function updateBackgroundGeneration(
  input: BackgroundGenerationUpdateInput,
): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.update(input.text, input.progress);
}

export async function stopBackgroundGeneration(): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.stop();
}
