// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  {
    ignores: [
      'dist/*',
      'dist-android/*',
      'coverage/*',
      '.eslint-report.json',
      '.harness/**',
    ],
  },
  expoConfig,
  {
    rules: {
      // Screens load data from SQLite on mount/focus and store the result in
      // component state. That is the intended pattern here; the React Compiler
      // lint rule cannot distinguish it from a render cascade.
      'react-hooks/set-state-in-effect': 'off',
      // We deliberately memoise derived reader/HTML values with explicit deps.
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', 'jest.setup.ts'],
    rules: {
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
    },
  },
]);
