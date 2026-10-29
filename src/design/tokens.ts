/**
 * Freehaven design tokens.
 *
 * Three palettes share one set of semantic roles so screens never hard-code
 * colours: a warm paper light theme, a night theme, and a low-contrast reading
 * theme used inside the reader.
 */

export const palettes = {
  light: {
    bg: '#F6F1E7',
    bgElevated: '#FBF7EE',
    surface: '#FFFDF8',
    surfaceAlt: '#EFE7D8',
    ink: '#1B1813',
    inkMuted: '#6B6355',
    inkFaint: '#9A9082',
    line: '#E2D8C6',
    lineStrong: '#CDBFa6',
    accent: '#2F5D50',
    accentInk: '#F4FBF7',
    accentSoft: '#DDE8E2',
    warm: '#B4552D',
    warmSoft: '#F3DFD4',
    gold: '#B07C2E',
    danger: '#A33B2B',
    dangerSoft: '#F4DDD8',
    shadow: 'rgba(43, 34, 20, 0.14)',
    overlay: 'rgba(27, 24, 19, 0.42)',
  },
  dark: {
    bg: '#12110F',
    bgElevated: '#191816',
    surface: '#1D1C19',
    surfaceAlt: '#26241F',
    ink: '#F3EDE2',
    inkMuted: '#A79E8E',
    inkFaint: '#7C7365',
    line: '#332F27',
    lineStrong: '#4A4438',
    accent: '#8FBFAE',
    accentInk: '#0F1A16',
    accentSoft: '#23342D',
    warm: '#E08A5C',
    warmSoft: '#3A281F',
    gold: '#D9AE6B',
    danger: '#E0806C',
    dangerSoft: '#3A241F',
    shadow: 'rgba(0, 0, 0, 0.5)',
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
  reading: {
    bg: '#F1E6D0',
    bgElevated: '#F6ECDA',
    surface: '#FBF3E2',
    surfaceAlt: '#EADCC2',
    ink: '#2B2418',
    inkMuted: '#6E6250',
    inkFaint: '#948671',
    line: '#DCCDB0',
    lineStrong: '#C6B391',
    accent: '#4A5D3A',
    accentInk: '#F7F9EF',
    accentSoft: '#E3E7D5',
    warm: '#A65A33',
    warmSoft: '#EEDCCB',
    gold: '#A87C36',
    danger: '#9C3B2B',
    dangerSoft: '#EFD9D2',
    shadow: 'rgba(60, 46, 26, 0.16)',
    overlay: 'rgba(43, 36, 24, 0.4)',
  },
} as const;

export type ThemeName = keyof typeof palettes;
export type Palette = (typeof palettes)[ThemeName];

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 34, lineHeight: 40, letterSpacing: -0.6 },
  title: { fontSize: 26, lineHeight: 32, letterSpacing: -0.3 },
  heading: { fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  subheading: { fontSize: 17, lineHeight: 23 },
  body: { fontSize: 16, lineHeight: 24 },
  bodySm: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 13, lineHeight: 18, letterSpacing: 0.2 },
  caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0.3 },
  mono: { fontSize: 13, lineHeight: 18 },
} as const;

export const motion = {
  fast: 140,
  base: 220,
  slow: 360,
} as const;

export const layout = {
  screenPadding: space.xl,
  tabBarHeight: 64,
  maxContentWidth: 720,
} as const;

