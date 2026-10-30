/**
 * Local TTS model bundle lifecycle.
 *
 * All filesystem work goes through injectable deps so the orchestration is
 * tested in Node; the Expo implementation is the default and is imported lazily
 * only when a function is actually called.
 */

import { downloadPath, modelDir } from '@/features/data/paths';

export type ModelBundleId =
  | 'kokoro-int8-multi-lang-v1_1'
  | 'vits-piper-en_US-lessac-medium'
  | 'vits-piper-en_US-amy-low';

export interface ModelBundle {
  id: ModelBundleId;
  engine: 'piper' | 'kokoro';
  label: string;
  url: string;
  expectedBytes: number;
  minBytes: number;
  maxBytes: number;
  modelType: 'vits' | 'kokoro';
  license: string;
  notes: string;
  requiredFiles: string[];
  /** Any one of these paths must also exist (e.g. fp32 vs int8 model). */
  alternatives?: string[][];
  speakers: number;
}

const ONE_PERCENT = 0.01;

function withSizeRange(
  bundle: Omit<ModelBundle, 'minBytes' | 'maxBytes'>,
): ModelBundle {
  return {
    ...bundle,
    minBytes: Math.floor(bundle.expectedBytes * (1 - ONE_PERCENT)),
    maxBytes: Math.ceil(bundle.expectedBytes * (1 + ONE_PERCENT)),
  };
}

export const MODEL_BUNDLES: readonly ModelBundle[] = [
  withSizeRange({
    id: 'kokoro-int8-multi-lang-v1_1',
    engine: 'kokoro',
    label: 'Kokoro 82M (multi-lang, int8)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2',
    expectedBytes: 147_052_523,
    modelType: 'kokoro',
    license: 'Apache-2.0 (Kokoro-82M)',
    notes: '103 voices; int8 is roughly 1-3× real time on mid-range phones — pre-generate, do not live-render.',
    requiredFiles: ['voices.bin', 'tokens.txt', 'espeak-ng-data'],
    alternatives: [['model.onnx', 'model.int8.onnx']],
    speakers: 103,
  }),
  withSizeRange({
    id: 'vits-piper-en_US-lessac-medium',
    engine: 'piper',
    label: 'Piper en_US lessac (medium)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2',
    expectedBytes: 67_230_653,
    modelType: 'vits',
    license: 'MIT voices / Apache-2.0 runtime',
    notes: 'Single-speaker fast English default; RTF is low enough for live-render on most phones.',
    requiredFiles: ['model.onnx', 'tokens.txt', 'espeak-ng-data'],
    speakers: 1,
  }),
  withSizeRange({
    id: 'vits-piper-en_US-amy-low',
    engine: 'piper',
    label: 'Piper en_US amy (low)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2',
    expectedBytes: 67_095_344,
    modelType: 'vits',
    license: 'MIT voices / Apache-2.0 runtime',
    notes: 'Smallest Piper English voice; fastest and most compact.',
    requiredFiles: ['model.onnx', 'tokens.txt', 'espeak-ng-data'],
    speakers: 1,
  }),
] as const;

export function getModelBundle(id: string): ModelBundle | undefined {
  return MODEL_BUNDLES.find((bundle) => bundle.id === id);
}

export function bundleFileName(bundle: ModelBundle): string {
  try {
    const name = new URL(bundle.url).pathname.split('/').filter(Boolean).pop();
    if (name) return name;
  } catch {
    /* fall through */
  }
  return `${bundle.id}.tar.bz2`;
}

export function archivePathFor(bundle: ModelBundle): string {
  return downloadPath(bundleFileName(bundle));
}

export function modelDirFor(bundle: ModelBundle): string {
  return modelDir(bundle.id);
}

export function sizeAccepted(bundle: ModelBundle, bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= bundle.minBytes && bytes <= bundle.maxBytes;
}

export type ModelArchive = {
  archivePath: string;
  modelId?: string;
  format?: 'tar.zst' | 'tar.bz2';
  fileSize?: number;
  fromAsset?: boolean;
};

export type ModelExtractProgress = { percent: number };

export type ModelFsDeps = {
  download?: (
    url: string,
    dest: string,
    onProgress?: (received: number | null) => void,
  ) => Promise<void>;
  exists: (path: string) => Promise<boolean> | boolean;
  size: (path: string) => Promise<number> | number;
  remove?: (path: string) => Promise<void> | void;
  /** Legacy/simple extractor used by injected tests. */
  extract?: (archive: string, dest: string) => Promise<void> | void;
  /** sherpa extractor pair: scan a directory, then unpack one descriptor. */
  listArchives?: (dir: string) => Promise<ModelArchive[]> | ModelArchive[];
  extractArchive?: (
    archive: ModelArchive,
    dest: string,
    options?: { force?: boolean; onProgress?: (event: ModelExtractProgress) => void },
  ) => Promise<unknown> | unknown;
  /** Directory listing (names only) used to find a single extracted root. */
  list?: (dir: string) => Promise<string[]> | string[];
  mkdir?: (path: string) => Promise<void> | void;
};

export type BundleOperationStatus = 'ready' | 'failed' | 'needs_extraction' | 'absent';

export type BundleResult = {
  status: BundleOperationStatus;
  bundleId: ModelBundleId;
  archivePath: string;
  modelDir: string;
  bytes?: number;
  error?: string;
  missing: string[];
};

function baseResult(bundle: ModelBundle): Pick<BundleResult, 'bundleId' | 'archivePath' | 'modelDir'> {
  return {
    bundleId: bundle.id,
    archivePath: archivePathFor(bundle),
    modelDir: modelDirFor(bundle),
  };
}

/** Return the first missing required path; alternatives need only one to exist. */
async function findMissing(bundle: ModelBundle, dir: string, deps: ModelFsDeps): Promise<string[]> {
  for (const relative of bundle.requiredFiles) {
    if (!(await deps.exists(`${dir}/${relative}`))) return [relative];
  }
  for (const group of bundle.alternatives ?? []) {
    let found = false;
    for (const candidate of group) {
      if (await deps.exists(`${dir}/${candidate}`)) {
        found = true;
        break;
      }
    }
    if (!found) return [group[0]];
  }
  return [];
}

export async function verifyBundle(
  bundle: ModelBundle,
  deps: ModelFsDeps,
  options: { archivePath?: string; modelDir?: string; checkArchive?: boolean } = {},
): Promise<BundleResult> {
  const result = baseResult(bundle);
  const archivePath = options.archivePath ?? result.archivePath;
  const targetDir = options.modelDir ?? result.modelDir;
  const checkArchive = options.checkArchive !== false;

  let bytes: number | undefined;
  if (checkArchive) {
    bytes = Number(await deps.size(archivePath));
    if (!sizeAccepted(bundle, bytes)) {
      return {
        ...result,
        archivePath,
        modelDir: targetDir,
        status: 'failed',
        error: 'download_incomplete',
        bytes,
        missing: [],
      };
    }
  }

  const missing = await findMissing(bundle, targetDir, deps);
  if (missing.length) {
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'failed',
      error: `missing ${missing[0]}`,
      bytes,
      missing,
    };
  }

  return {
    ...result,
    archivePath,
    modelDir: targetDir,
    status: 'ready',
    bytes,
    missing: [],
  };
}

function parentDir(path: string): string {
  return path.replace(/\/[^/]+$/, '');
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * Archives usually contain one top-level folder. Check the target itself first
 * (flat archives), then one level of children (wrapped archives).
 */
export async function resolveExtractedRoot(
  bundle: ModelBundle,
  dir: string,
  deps: ModelFsDeps,
): Promise<string> {
  if ((await findMissing(bundle, dir, deps)).length === 0) return dir;
  const entries = deps.list ? await deps.list(dir) : [];
  for (const name of entries ?? []) {
    if (!name) continue;
    const candidate = `${dir}/${name}`;
    if ((await findMissing(bundle, candidate, deps)).length === 0) return candidate;
  }
  return dir;
}

/**
 * Run the configured extractor. Returns the detected model root, or null when
 * no extractor is available at all (the caller reports `needs_extraction`).
 */
async function runExtraction(
  bundle: ModelBundle,
  deps: ModelFsDeps,
  archivePath: string,
  targetDir: string,
  onProgress?: (event: ModelExtractProgress) => void,
): Promise<string | null> {
  await deps.remove?.(targetDir);
  await deps.mkdir?.(targetDir);

  if (deps.listArchives && deps.extractArchive) {
    const archives = await deps.listArchives(parentDir(archivePath));
    const wanted = fileName(archivePath);
    const match = archives.find(
      (archive) =>
        fileName(archive.archivePath) === wanted ||
        (archive.modelId !== undefined && wanted.startsWith(archive.modelId)),
    );
    if (!match) throw new Error('archive_not_found');
    await deps.extractArchive(match, targetDir, { force: true, onProgress });
  } else if (deps.extract) {
    await deps.extract(archivePath, targetDir);
  } else {
    return null;
  }

  return resolveExtractedRoot(bundle, targetDir, deps);
}

export async function downloadBundle(
  bundle: ModelBundle,
  deps: ModelFsDeps,
  options: {
    onProgress?: (received: number | null) => void;
    onExtractProgress?: (event: ModelExtractProgress) => void;
    archivePath?: string;
    modelDir?: string;
  } = {},
): Promise<BundleResult> {
  const result = baseResult(bundle);
  const archivePath = options.archivePath ?? result.archivePath;
  const targetDir = options.modelDir ?? result.modelDir;

  if (!deps.download) {
    return { ...result, archivePath, modelDir: targetDir, status: 'failed', error: 'no_downloader', missing: [] };
  }

  // No Range resume: start from a clean archive so a partial prior attempt
  // can never pass the size gate.
  await deps.remove?.(archivePath);
  await deps.mkdir?.(archivePath.replace(/\/[^/]+$/, ''));
  await deps.download(bundle.url, archivePath, options.onProgress);

  const bytes = Number(await deps.size(archivePath));
  if (!sizeAccepted(bundle, bytes)) {
    await deps.remove?.(archivePath);
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'failed',
      error: 'download_incomplete',
      bytes,
      missing: [],
    };
  }

  let root: string | null;
  try {
    root = await runExtraction(
      bundle,
      deps,
      archivePath,
      targetDir,
      options.onExtractProgress,
    );
  } catch (error) {
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'failed',
      error: error instanceof Error ? error.message : 'extract_failed',
      bytes,
      missing: [],
    };
  }

  if (!root) {
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'needs_extraction',
      error: 'needs_extraction',
      bytes,
      missing: [],
    };
  }

  const verified = await verifyBundle(bundle, deps, {
    archivePath,
    modelDir: root,
    checkArchive: true,
  });
  if (verified.status === 'failed') await deps.remove?.(targetDir);
  return verified;
}

/**
 * Extract an already-downloaded archive. Without a native extractor the archive
 * is kept and the caller shows the "import extracted folder" fallback.
 */
export async function extractBundle(
  bundle: ModelBundle,
  deps: ModelFsDeps,
  options: {
    archivePath?: string;
    modelDir?: string;
    onExtractProgress?: (event: ModelExtractProgress) => void;
  } = {},
): Promise<BundleResult> {
  const result = baseResult(bundle);
  const archivePath = options.archivePath ?? result.archivePath;
  const targetDir = options.modelDir ?? result.modelDir;

  const bytes = Number(await deps.size(archivePath));
  if (!sizeAccepted(bundle, bytes)) {
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'failed',
      error: 'download_incomplete',
      bytes,
      missing: [],
    };
  }

  let root: string | null;
  try {
    root = await runExtraction(bundle, deps, archivePath, targetDir, options.onExtractProgress);
  } catch (error) {
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'failed',
      error: error instanceof Error ? error.message : 'extract_failed',
      bytes,
      missing: [],
    };
  }

  if (!root) {
    return {
      ...result,
      archivePath,
      modelDir: targetDir,
      status: 'needs_extraction',
      error: 'needs_extraction',
      bytes,
      missing: [],
    };
  }

  const verified = await verifyBundle(bundle, deps, {
    archivePath,
    modelDir: root,
    checkArchive: false,
  });
  if (verified.status === 'failed') await deps.remove?.(targetDir);
  return verified;
}

/** Delete the extracted directory and the archive; status becomes `absent`. */
export async function deleteBundle(
  bundle: ModelBundle,
  deps: ModelFsDeps,
): Promise<BundleResult> {
  const result = baseResult(bundle);
  await deps.remove?.(result.modelDir);
  await deps.remove?.(result.archivePath);
  return { ...result, status: 'absent', missing: [] };
}

/** Cheap launch-time check: files only, no hashing. */
export async function reverifyInstalled(
  bundle: ModelBundle,
  deps: ModelFsDeps,
  options: { modelDir?: string } = {},
): Promise<BundleResult> {
  const result = baseResult(bundle);
  const targetDir = options.modelDir ?? result.modelDir;

  if (!(await deps.exists(targetDir))) {
    return { ...result, modelDir: targetDir, status: 'absent', missing: [] };
  }

  const root = await resolveExtractedRoot(bundle, targetDir, deps);
  const missing = await findMissing(bundle, root, deps);
  if (missing.length) {
    return {
      ...result,
      modelDir: root,
      status: 'failed',
      error: 'model_unverified',
      missing,
    };
  }

  return { ...result, modelDir: root, status: 'ready', missing: [] };
}

/* --------------------------------------------------------- Expo defaults */

function documentPath(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const root = String(Paths.document.uri ?? '').replace(/\/+$/, '');
  return `${root}/${relative}`;
}

/** sherpa/RNFS expect a plain filesystem path, not an Expo `file://` URI. */
function nativePath(pathOrRelative: string): string {
  const full = /^(file:|\/)/.test(pathOrRelative)
    ? pathOrRelative
    : documentPath(pathOrRelative);
  return full.replace(/^file:\/\//, '');
}

/** Lazy Expo implementation; never evaluated by Jest imports. */
export function defaultModelDeps(): ModelFsDeps {
  return {
    async download(url, dest, onProgress) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File } = require('expo-file-system') as typeof import('expo-file-system');
      const file = await File.downloadFileAsync(url, new File(documentPath(dest)), {
        idempotent: true,
      });
      onProgress?.(file.size ?? null);
    },
    exists(path) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Directory, File } = require('expo-file-system') as typeof import('expo-file-system');
        const full = documentPath(path);
        if (new File(full).exists) return true;
        return new Directory(full).exists;
      } catch {
        return false;
      }
    },
    size(path) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { File } = require('expo-file-system') as typeof import('expo-file-system');
        return new File(documentPath(path)).size ?? 0;
      } catch {
        return 0;
      }
    },
    remove(path) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Directory, File } = require('expo-file-system') as typeof import('expo-file-system');
        const full = documentPath(path);
        const file = new File(full);
        if (file.exists) {
          file.delete();
          return;
        }
        const dir = new Directory(full);
        if (dir.exists) dir.delete();
      } catch {
        /* already gone */
      }
    },
    mkdir(path) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Directory } = require('expo-file-system') as typeof import('expo-file-system');
      const dir = new Directory(documentPath(path));
      if (!dir.exists) dir.create({ intermediates: true });
    },
    list(path) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Directory } = require('expo-file-system') as typeof import('expo-file-system');
        const dir = new Directory(documentPath(path));
        if (!dir.exists) return [];
        return dir.list().map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    listArchives(dir) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadSherpaModule } = require('./sherpa') as typeof import('./sherpa');
      const mod = loadSherpaModule();
      if (!mod?.listBundledArchives) throw new Error('extraction_unavailable');
      return Promise.resolve(mod.listBundledArchives(nativePath(dir)));
    },
    extractArchive(archive, dest, options) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadSherpaModule } = require('./sherpa') as typeof import('./sherpa');
      const mod = loadSherpaModule();
      if (!mod?.extractArchive) throw new Error('extraction_unavailable');
      return Promise.resolve(
        mod.extractArchive(archive, nativePath(dest), {
          force: options?.force ?? true,
          onProgress: options?.onProgress,
          showNotificationsEnabled: false,
        }),
      ).then((result) => {
        if (result && typeof result === 'object' && 'success' in result) {
          if ((result as { success?: boolean }).success === false) {
            throw new Error('extraction_failed');
          }
        }
        return result;
      });
    },
  };
}
