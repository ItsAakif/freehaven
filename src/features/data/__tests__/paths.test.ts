/** @jest-environment node */
import {
  CACHE_DIRS,
  PERSISTENT_DIRS,
  downloadPath,
  modelDir,
  modelsRoot,
  segmentDir,
  segmentPath,
} from '@/features/data/paths';

describe('filesystem paths', () => {
  it('keeps cache and persistent directory names disjoint', () => {
    const overlap = CACHE_DIRS.filter((name) => (PERSISTENT_DIRS as readonly string[]).includes(name));
    expect(overlap).toEqual([]);
    expect(CACHE_DIRS).toEqual(['downloads', 'narration']);
    expect(PERSISTENT_DIRS).toEqual(['library', 'renditions', 'models']);
  });

  it('builds rendition segment paths under Paths.document', () => {
    expect(segmentDir('rd_1')).toBe('renditions/rd_1');
    expect(segmentPath('rd_1', 0, 'wav')).toBe('renditions/rd_1/0.wav');
    expect(segmentPath('rd_1', 12, 'mp3')).toBe('renditions/rd_1/12.mp3');
  });

  it('builds model and download paths under Paths.document/models', () => {
    expect(modelsRoot()).toBe('models');
    expect(modelDir('piper-en-lessac')).toBe('models/piper-en-lessac');
    expect(downloadPath('piper-en-lessac.tar.bz2')).toBe('models/downloads/piper-en-lessac.tar.bz2');
  });
});
