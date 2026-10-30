/**
 * Filesystem layout constants and pure path builders.
 *
 * Everything here is a relative string under `Paths.document` (or `Paths.cache`
 * for the cache list). Keeping the builders free of Expo imports lets Jest test
 * them in a Node environment; only `clearCaches` reaches for the native module,
 * lazily, at call time.
 */

export const CACHE_DIRS = ['downloads', 'narration'] as const;
export const PERSISTENT_DIRS = ['library', 'renditions', 'models'] as const;

/** `renditions/<renditionId>` under Paths.document. */
export function segmentDir(renditionId: string): string {
  return `renditions/${renditionId}`;
}

/** `renditions/<renditionId>/<ordinal>.<format>` under Paths.document. */
export function segmentPath(
  renditionId: string,
  ordinal: number,
  format: 'mp3' | 'wav',
): string {
  return `${segmentDir(renditionId)}/${ordinal}.${format}`;
}

/** `models` under Paths.document. */
export function modelsRoot(): string {
  return 'models';
}

/** `models/<bundleId>` under Paths.document. */
export function modelDir(bundleId: string): string {
  return `${modelsRoot()}/${bundleId}`;
}

/** `models/downloads/<bundleFile>` under Paths.document (archive staging). */
export function downloadPath(bundleFile: string): string {
  return `${modelsRoot()}/downloads/${bundleFile}`;
}

/**
 * Delete only the provider/download caches. Library files, rendition audio and
 * downloaded model bundles are user assets and stay put.
 */
export function clearCaches(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  for (const name of CACHE_DIRS) {
    const dir = new Directory(Paths.cache, name);
    if (dir.exists) dir.delete();
  }
}
