/**
 * Startup view resolution.
 *
 * Kept pure so the root layout and its tests agree on when the splash may stay
 * up. A database error always wins: the error UI must be reachable even if
 * preference hydration (and therefore the normal splash-hiding path) stalls.
 */

export type DatabaseStartupStatus = 'loading' | 'ready' | 'error';

export type StartupView = 'splash' | 'app' | 'error';

export function resolveStartupView(input: {
  database: DatabaseStartupStatus;
  hydrated: boolean;
  /** True once the 1.8 s fallback has elapsed. */
  splashHidden: boolean;
}): StartupView {
  if (input.database === 'error') return 'error';
  if (input.database === 'ready') return 'app';
  if (input.hydrated || input.splashHidden) return 'app';
  return 'splash';
}
