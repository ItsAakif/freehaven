import {
  MODEL_BUNDLES,
  archivePathFor,
  deleteBundle,
  downloadBundle,
  extractBundle,
  getModelBundle,
  modelDirFor,
  reverifyInstalled,
  sizeAccepted,
  verifyBundle,
  type ModelBundle,
  type ModelFsDeps,
} from '@/features/narration/models';

type FakeEntry = { kind: 'file' | 'dir'; size: number };

function fakeFs(entries: Record<string, FakeEntry>): ModelFsDeps & {
  entries: Record<string, FakeEntry>;
  removed: string[];
} {
  const state = entries;
  const removed: string[] = [];
  return {
    entries: state,
    removed,
    exists: (path) => !!state[path],
    size: (path) => state[path]?.size ?? 0,
    remove: (path) => {
      removed.push(path);
      delete state[path];
    },
    mkdir: (path) => {
      state[path] = { kind: 'dir', size: 0 };
    },
    list: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(state)) {
        if (!key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
  };
}

function readyEntries(bundle: ModelBundle): Record<string, FakeEntry> {
  const dir = modelDirFor(bundle);
  const entries: Record<string, FakeEntry> = {
    [dir]: { kind: 'dir', size: 0 },
    [archivePathFor(bundle)]: { kind: 'file', size: bundle.expectedBytes },
  };
  for (const file of bundle.requiredFiles) entries[`${dir}/${file}`] = { kind: 'file', size: 10 };
  for (const group of bundle.alternatives ?? []) {
    entries[`${dir}/${group[0]}`] = { kind: 'file', size: 10 };
  }
  return entries;
}

const piper = getModelBundle('vits-piper-en_US-lessac-medium') as ModelBundle;
const kokoro = getModelBundle('kokoro-int8-multi-lang-v1_1') as ModelBundle;

describe('model manifest', () => {
  it('has unique ids and valid size ranges', () => {
    const ids = MODEL_BUNDLES.map((bundle) => bundle.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MODEL_BUNDLES).toHaveLength(3);
    for (const bundle of MODEL_BUNDLES) {
      expect(bundle.expectedBytes).toBeGreaterThanOrEqual(bundle.minBytes);
      expect(bundle.expectedBytes).toBeLessThanOrEqual(bundle.maxBytes);
      expect(bundle.minBytes).toBe(Math.floor(bundle.expectedBytes * 0.99));
      expect(bundle.maxBytes).toBe(Math.ceil(bundle.expectedBytes * 1.01));
      expect(bundle.requiredFiles.length).toBeGreaterThan(0);
      expect(bundle.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
    }
  });

  it('pins the verified byte counts and sizes', () => {
    expect(kokoro.expectedBytes).toBe(147_052_523);
    expect(piper.expectedBytes).toBe(67_230_653);
    expect(getModelBundle('vits-piper-en_US-amy-low')?.expectedBytes).toBe(67_095_344);
    expect(sizeAccepted(piper, piper.expectedBytes)).toBe(true);
    expect(sizeAccepted(piper, Math.floor(piper.expectedBytes * 0.985))).toBe(false);
    expect(sizeAccepted(piper, Math.ceil(piper.expectedBytes * 1.015))).toBe(false);
  });
});

describe('model bundle lifecycle', () => {
  it('rejects an archive more than 1% off', async () => {
    const deps = fakeFs({
      [archivePathFor(piper)]: { kind: 'file', size: Math.round(piper.expectedBytes * 1.02) },
    });
    const result = await verifyBundle(piper, deps);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('download_incomplete');
  });

  it('fails with the missing path when model.onnx is absent', async () => {
    const entries = readyEntries(piper);
    delete entries[`${modelDirFor(piper)}/model.onnx`];
    const result = await verifyBundle(piper, fakeFs(entries));
    expect(result.status).toBe('failed');
    expect(result.missing).toEqual(['model.onnx']);
    expect(result.error).toContain('model.onnx');
  });

  it('accepts either fp32 or int8 kokoro model files', async () => {
    const entries = readyEntries(kokoro);
    delete entries[`${modelDirFor(kokoro)}/model.onnx`];
    entries[`${modelDirFor(kokoro)}/model.int8.onnx`] = { kind: 'file', size: 10 };
    const result = await verifyBundle(kokoro, fakeFs(entries));
    expect(result.status).toBe('ready');
  });

  it('returns ready when the archive size and every required file are present', async () => {
    const result = await verifyBundle(piper, fakeFs(readyEntries(piper)));
    expect(result.status).toBe('ready');
    expect(result.missing).toEqual([]);
  });

  it('keeps the archive and reports needs_extraction without an extractor', async () => {
    const deps = fakeFs({
      [archivePathFor(piper)]: { kind: 'file', size: piper.expectedBytes },
    });
    const result = await extractBundle(piper, deps);
    expect(result.status).toBe('needs_extraction');
    expect(deps.entries[archivePathFor(piper)]).toBeDefined();
  });

  it('deletes the directory and archive and reports absent', async () => {
    const deps = fakeFs(readyEntries(piper));
    const result = await deleteBundle(piper, deps);
    expect(result.status).toBe('absent');
    expect(deps.entries[modelDirFor(piper)]).toBeUndefined();
    expect(deps.entries[archivePathFor(piper)]).toBeUndefined();
  });

  it('downloads, verifies and extracts when an extractor is available', async () => {
    const deps = fakeFs({});
    deps.download = async (_url, dest) => {
      deps.entries[dest] = { kind: 'file', size: piper.expectedBytes };
    };
    deps.extract = async (_archive, dest) => {
      deps.entries[dest] = { kind: 'dir', size: 0 };
      for (const file of piper.requiredFiles) deps.entries[`${dest}/${file}`] = { kind: 'file', size: 10 };
    };
    const result = await downloadBundle(piper, deps);
    expect(result.status).toBe('ready');
  });

  it('uses listArchives + extractArchive and detects a wrapped top-level folder', async () => {
    const deps = fakeFs({});
    deps.download = async (_url, dest) => {
      deps.entries[dest] = { kind: 'file', size: piper.expectedBytes };
    };
    deps.listArchives = async (dir) => {
      expect(dir).toBe('models/downloads');
      return [
        {
          archivePath: archivePathFor(piper),
          modelId: 'vits-piper-en_US-lessac-medium',
          format: 'tar.bz2',
        },
      ];
    };
    deps.extractArchive = async (archive, dest) => {
      expect(archive.archivePath).toBe(archivePathFor(piper));
      const root = `${dest}/vits-piper-en_US-lessac-medium`;
      deps.entries[root] = { kind: 'dir', size: 0 };
      for (const file of piper.requiredFiles) {
        deps.entries[`${root}/${file}`] = { kind: 'file', size: 10 };
      }
      return { success: true, path: root };
    };

    const result = await downloadBundle(piper, deps);
    expect(result.status).toBe('ready');
    expect(result.modelDir).toBe(`${modelDirFor(piper)}/vits-piper-en_US-lessac-medium`);
    expect(deps.entries[result.modelDir]).toBeDefined();
  });

  it('fails cleanly when the archive is not listed', async () => {
    const deps = fakeFs({});
    deps.download = async (_url, dest) => {
      deps.entries[dest] = { kind: 'file', size: piper.expectedBytes };
    };
    deps.listArchives = async () => [];
    deps.extractArchive = async () => ({ success: true });

    const result = await downloadBundle(piper, deps);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('archive_not_found');
  });

  it('demotes a missing installed file to model_unverified', async () => {
    const entries = readyEntries(piper);
    delete entries[`${modelDirFor(piper)}/tokens.txt`];
    const result = await reverifyInstalled(piper, fakeFs(entries));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('model_unverified');
    expect(result.missing).toEqual(['tokens.txt']);
  });

  it('reports absent when the model directory is gone', async () => {
    const result = await reverifyInstalled(piper, fakeFs({}));
    expect(result.status).toBe('absent');
  });
});
