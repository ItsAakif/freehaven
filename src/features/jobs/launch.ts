/**
 * Launch and foreground recovery wiring.
 *
 * A fresh process has provably no runner, so every `running` job is orphaned on
 * boot. On foreground we only reclaim jobs whose heartbeat is older than the
 * lease, because an in-process runner may still be working.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { recoverStaleJobs } from '@/data/repositories/jobs';
import { recoverOnLaunch } from './runner';

export async function recoverGenerationOnLaunch(input: {
  now: number;
}): Promise<{ recovered: number; cancelled: number }> {
  try {
    return await recoverOnLaunch(input);
  } catch {
    return { recovered: 0, cancelled: 0 };
  }
}

export function recoverGenerationOnForeground(input: {
  now: number;
}): Promise<{ recovered: number; cancelled: number }> {
  return recoverStaleJobs({ mode: 'lease', now: input.now }).catch(() => ({
    recovered: 0,
    cancelled: 0,
  }));
}

/** Subscribe once per process; returns the unsubscribe function. */
export function subscribeToForegroundRecovery(
  now: () => number = () => Date.now(),
): () => void {
  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void recoverGenerationOnForeground({ now: now() });
  });
  return () => subscription.remove();
}
