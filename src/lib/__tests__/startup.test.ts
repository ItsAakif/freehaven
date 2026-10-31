import { resolveStartupView } from '@/lib/startup';

describe('startup view resolution', () => {
  it('shows the database error even while the splash has not been hidden', () => {
    expect(
      resolveStartupView({ database: 'error', hydrated: false, splashHidden: false }),
    ).toBe('error');
  });

  it('keeps the splash while preferences are still hydrating', () => {
    expect(
      resolveStartupView({ database: 'loading', hydrated: false, splashHidden: false }),
    ).toBe('splash');
  });

  it('leaves the splash once preferences hydrate or the fallback elapses', () => {
    expect(
      resolveStartupView({ database: 'loading', hydrated: true, splashHidden: false }),
    ).toBe('app');
    expect(
      resolveStartupView({ database: 'loading', hydrated: false, splashHidden: true }),
    ).toBe('app');
  });

  it('switches to the app as soon as the database is ready', () => {
    expect(
      resolveStartupView({ database: 'ready', hydrated: false, splashHidden: false }),
    ).toBe('app');
  });
});
