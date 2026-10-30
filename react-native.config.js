/**
 * Autolinking guard.
 *
 * `react-native-sherpa-onnx` declares `@kesha-antonov/react-native-background-downloader`
 * as an optional peer. We never use sherpa's `download` subpath (downloads go
 * through expo-file-system), so keep that package out of the Android/iOS build
 * if it ever appears in node_modules.
 */
module.exports = {
  dependencies: {
    '@kesha-antonov/react-native-background-downloader': {
      platforms: {
        android: null,
        ios: null,
      },
    },
  },
};
