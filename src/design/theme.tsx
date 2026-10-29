import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { palettes, type Palette, type ThemeName } from './tokens';
import { usePreferences, type ThemeMode } from '@/state/preferences';

type ThemeContextValue = {
  name: ThemeName;
  palette: Palette;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  isDark: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const mode = usePreferences((s) => s.themeMode);
  const setThemeMode = usePreferences((s) => s.setThemeMode);

  const name: ThemeName =
    mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : (mode as ThemeName);

  const value = useMemo<ThemeContextValue>(
    () => ({
      name,
      palette: palettes[name],
      mode,
      setMode: setThemeMode,
      isDark: name === 'dark',
    }),
    [name, mode, setThemeMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/** Memoised StyleSheet factory bound to the active palette. */
export function useThemedStyles<T>(factory: (palette: Palette) => T): T {
  const { palette } = useTheme();
  const styles = useMemo(() => factory(palette), [factory, palette]);
  return styles;
}

/** Convenience: run a callback with a one-off palette (e.g. inside modals). */
export function usePalette() {
  return useTheme().palette;
}

export function useReadingThemeName(): ThemeName {
  const { name, mode } = useTheme();
  return mode === 'reading' ? 'reading' : name;
}

export const useToastPalette = () => useTheme().palette;

export function useThemeToggle() {
  const { mode, setMode } = useTheme();
  const toggle = useCallback(() => {
    const order: ThemeMode[] = ['light', 'dark', 'reading'];
    const idx = order.indexOf(mode === 'system' ? 'light' : (mode as ThemeMode));
    setMode(order[(idx + 1) % order.length]);
  }, [mode, setMode]);
  return toggle;
}
