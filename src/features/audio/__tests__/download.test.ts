/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { listQueue, syncQueue } from '@/data/repositories/audioQueue';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { downloadSections } from '@/features/audio/download';
import type { SpeechAsset, SpeechSynthesisProvider } from '@/features/audio/providers';

class FakeProvider implements SpeechSynthesisProvider {
  id = 'fake';
  label = 'Fake';
  requiresKey = false;
  calls = 0;
  async isAvailable() {
    return true;
  }
  async synthesize(): Promise<SpeechAsset> {
    this.calls += 1;
    return { uri: `file:///audio-${this.calls}.mp3`, bytes: 10, cached: false };
  }
}

describe('offline audio download', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await upsertCatalogueBook({
      id: 'b1',
      provider: 'gutendex',
      title: 'Book',
      subjects: [],
      source: 'gutenberg',
      sourceId: 'b1',
      access: 'public_domain',
    });
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* closed */
    }
  });

  it('synthesises queued sections and records their files', async () => {
    const sections = [
      { id: 's1', title: 'One', text: 'First section text.' },
      { id: 's2', title: 'Two', text: 'Second section text.' },
    ];
    const queue = await syncQueue('b1', sections);
    const provider = new FakeProvider();
    const progress = await downloadSections({
      queue,
      sections,
      provider,
      voice: 'alloy',
      model: 'tts-1',
      language: 'en-US',
    });
    expect(progress.done).toBe(2);
    expect(progress.failed).toBe(0);
    expect(provider.calls).toBe(2);
    const stored = await listQueue('b1');
    expect(stored.every((item) => item.status === 'ready')).toBe(true);
    expect(stored.every((item) => item.filePath?.startsWith('file:///audio-'))).toBe(true);
  });

  it('skips sections that are already cached', async () => {
    const sections = [{ id: 's1', title: 'One', text: 'First section text.' }];
    const queue = await syncQueue('b1', sections);
    const provider = new FakeProvider();
    await downloadSections({ queue, sections, provider, voice: 'alloy', model: 'tts-1', language: 'en-US' });
    const again = await listQueue('b1');
    const second = await downloadSections({
      queue: again,
      sections,
      provider,
      voice: 'alloy',
      model: 'tts-1',
      language: 'en-US',
    });
    expect(second.skipped).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it('records failures without losing the queue', async () => {
    const sections = [{ id: 's1', title: 'One', text: 'First section text.' }];
    const queue = await syncQueue('b1', sections);
    const failing: SpeechSynthesisProvider = {
      id: 'fail',
      label: 'Fail',
      requiresKey: false,
      isAvailable: async () => true,
      synthesize: async () => {
        throw new Error('offline');
      },
    };
    const progress = await downloadSections({
      queue,
      sections,
      provider: failing,
      voice: 'alloy',
      model: 'tts-1',
      language: 'en-US',
    });
    expect(progress.failed).toBe(1);
    const stored = await listQueue('b1');
    expect(stored[0].status).toBe('queued');
  });
});
