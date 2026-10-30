/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import {
  deleteNarrationEngine,
  getNarrationEngine,
  listNarrationEngines,
  setNarrationEngineProgress,
  setNarrationEngineStatus,
  updateNarrationEngine,
  upsertNarrationEngine,
} from '@/data/repositories/narrationEngines';

describe('narration engines repository', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('inserts and reads a bundle row', async () => {
    const created = await upsertNarrationEngine({
      id: 'piper-en',
      engine: 'piper',
      label: 'Piper',
      bundleUrl: 'https://example.test/piper.tar.bz2',
      bundleBytes: 100,
    });
    expect(created.status).toBe('absent');
    expect(created.progress).toBe(0);
    expect(await getNarrationEngine('piper-en')).toMatchObject({ id: 'piper-en', label: 'Piper' });
    expect(await listNarrationEngines()).toHaveLength(1);
  });

  it('upserts without duplicating and updates fields', async () => {
    await upsertNarrationEngine({ id: 'kokoro', engine: 'kokoro', label: 'Kokoro' });
    const updated = await upsertNarrationEngine({
      id: 'kokoro',
      engine: 'kokoro',
      label: 'Kokoro int8',
      status: 'downloading',
      progress: 0.4,
    });
    expect(updated.label).toBe('Kokoro int8');
    expect(updated.status).toBe('downloading');
    expect(await listNarrationEngines()).toHaveLength(1);
  });

  it('patches a row and clamps progress', async () => {
    await upsertNarrationEngine({ id: 'kokoro', engine: 'kokoro', label: 'Kokoro' });
    await updateNarrationEngine('kokoro', {
      modelDir: 'models/kokoro',
      verifiedAt: 123,
    });
    await setNarrationEngineProgress('kokoro', 4);
    const row = await getNarrationEngine('kokoro');
    expect(row?.modelDir).toBe('models/kokoro');
    expect(row?.verifiedAt).toBe(123);
    expect(row?.progress).toBe(1);
  });

  it('sets status and error, then deletes', async () => {
    await upsertNarrationEngine({ id: 'piper', engine: 'piper', label: 'Piper' });
    await setNarrationEngineStatus('piper', 'failed', 'download_incomplete');
    const row = await getNarrationEngine('piper');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('download_incomplete');
    await deleteNarrationEngine('piper');
    expect(await getNarrationEngine('piper')).toBeNull();
  });
});
