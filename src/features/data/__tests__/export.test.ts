/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { dataCounts } from '@/data/repositories/learning';
import { exportUserData } from '@/features/data/export';

jest.mock('expo-file-system', () => {
  class FakeFile {
    uri = 'file:///fake/export.json';
    exists = false;
    create() {}
    delete() {}
    async write(value: string) {
      (globalThis as unknown as { __exportJson?: string }).__exportJson = value;
    }
  }
  class FakeDirectory {
    exists = false;
    size = 0;
    create() {}
    delete() {}
  }
  return {
    File: FakeFile,
    Directory: FakeDirectory,
    Paths: { document: {}, cache: {}, bundle: {} },
  };
});

describe('export and counts', () => {
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

  it('includes the rendition tables even on an empty database', async () => {
    await exportUserData();
    const raw = (globalThis as unknown as { __exportJson?: string }).__exportJson;
    expect(raw).toBeTruthy();
    const payload = JSON.parse(raw as string) as Record<string, unknown>;
    expect(payload).toHaveProperty('renditions');
    expect(payload).toHaveProperty('rendition_segments');
    expect(payload).toHaveProperty('rendition_progress');
    expect(payload).not.toHaveProperty('narration_engines');
    expect(payload.renditions).toEqual([]);
  });

  it('counts renditions for the storage summary', async () => {
    const counts = await dataCounts();
    expect(counts).toHaveProperty('renditions');
    expect(counts.renditions).toBe(0);
  });
});
