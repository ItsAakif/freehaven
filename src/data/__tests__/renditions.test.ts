/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { setInLibrary, upsertCatalogueBook } from '@/data/repositories/books';
import { saveReadingPosition } from '@/data/repositories/reading';
import {
  deleteRendition,
  getOrCreateRendition,
  getRenditionProgress,
  isRenditionDownloaded,
  listLibraryEntries,
  listRenditions,
  listSegments,
  renditionKey,
  renditionStats,
  replaceSegments,
  saveRenditionProgress,
  setRenditionEngine,
  updateRenditionScript,
  updateSegment,
} from '@/data/repositories/renditions';
import type { QueuedSegment } from '@/domain/narration';

const book = (id: string, title = 'Book') => ({
  id,
  provider: 'gutendex',
  title,
  author: 'Author',
  subjects: ['fiction'],
  source: 'gutenberg' as const,
  sourceId: id,
  access: 'public_domain' as const,
  license: 'Public domain',
  epubUrl: `https://example.org/${id}.epub`,
  externalUrl: `https://www.gutenberg.org/ebooks/${id}`,
});

const segment = (text: string, speechKey: string): QueuedSegment => ({
  sectionId: 's1',
  sectionOrdinal: 0,
  title: 'Chapter one',
  text,
  speechKey,
});

describe('renditions repository', () => {
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

  it('getOrCreateRendition is idempotent per tuple and keyed by style', async () => {
    await upsertCatalogueBook(book('b1'));
    const first = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'fireside',
      length: '15',
    });
    const second = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'fireside',
      length: '15',
    });
    expect(second.id).toBe(first.id);
    expect(await driver.all('SELECT * FROM renditions')).toHaveLength(1);
    expect(first.status).toBe('draft');
    expect(first.engine).toBe('device');
    expect(first.wordCount).toBe(0);

    const other = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'brief',
      length: '15',
    });
    expect(other.id).not.toBe(first.id);
    expect(renditionKey({ bookId: 'b1', language: 'en', styleId: 'fireside', length: '15' })).toBe(
      'b1|en|fireside|15',
    );
  });

  it('replaceSegments preserves unchanged files and resets changed keys', async () => {
    await upsertCatalogueBook(book('b1'));
    const rendition = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'plain',
      length: '5',
    });
    const first = await replaceSegments(rendition.id, [
      segment('one', 'key1'),
      segment('two', 'key2'),
    ]);
    expect(first).toHaveLength(2);
    expect(first[0].ordinal).toBe(0);
    expect(first[0].status).toBe('queued');

    await updateSegment(first[0].id, {
      speechKey: 'key1',
      filePath: '/tmp/one.wav',
      format: 'wav',
      durationMs: 1234,
      bytes: 99,
      status: 'ready',
    });

    const second = await replaceSegments(rendition.id, [
      segment('one', 'key1'),
      segment('two', 'key2'),
    ]);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    expect(second[0].filePath).toBe('/tmp/one.wav');
    expect(second[0].durationMs).toBe(1234);
    expect(second[0].status).toBe('ready');

    const changed = await replaceSegments(rendition.id, [
      segment('one', 'key1'),
      segment('two changed', 'key3'),
    ]);
    expect(changed[0].id).toBe(first[0].id);
    expect(changed[0].filePath).toBe('/tmp/one.wav');
    expect(changed[1].status).toBe('queued');
    expect(changed[1].filePath).toBeNull();
    expect(changed[1].durationMs).toBeNull();

    expect(await replaceSegments(rendition.id, [])).toEqual([]);
    expect(await listSegments(rendition.id)).toEqual([]);
  });

  it('updates scripts, engines and reports stats', async () => {
    await upsertCatalogueBook(book('b1'));
    const rendition = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'plain',
      length: '15',
    });
    await updateRenditionScript(rendition.id, {
      scriptMd: 'A script.',
      provider: 'extractive',
      model: null,
      wordCount: 2,
      status: 'script_ready',
    });
    await setRenditionEngine(rendition.id, {
      engine: 'remote',
      voice: 'nova',
      model: 'tts-1',
      instruction: 'slow down',
      instructionHash: 'abcd1234',
    });
    const rows = await listRenditions('b1');
    expect(rows[0].scriptMd).toBe('A script.');
    expect(rows[0].status).toBe('script_ready');
    expect(rows[0].engine).toBe('remote');
    expect(rows[0].instructionHash).toBe('abcd1234');

    const segments = await replaceSegments(rendition.id, [
      segment('one', 'k1'),
      segment('two', 'k2'),
    ]);
    await updateSegment(segments[0].id, { status: 'ready', filePath: '/a', bytes: 10, durationMs: 500 });
    await updateSegment(segments[1].id, { status: 'failed', error: 'nope' });
    expect(await renditionStats(rendition.id)).toEqual({
      segments: 2,
      ready: 1,
      failed: 1,
      bytes: 10,
      durationMs: 500,
    });
  });

  it('saveRenditionProgress upserts and clamps percent', async () => {
    await upsertCatalogueBook(book('b1'));
    const rendition = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'plain',
      length: '15',
    });
    await saveRenditionProgress({
      renditionId: rendition.id,
      positionMs: -50,
      percent: 2,
      completed: true,
    });
    let progress = await getRenditionProgress(rendition.id);
    expect(progress?.positionMs).toBe(0);
    expect(progress?.percent).toBe(1);
    expect(progress?.completed).toBe(true);

    await saveRenditionProgress({
      renditionId: rendition.id,
      positionMs: 1234,
      percent: -1,
      completed: false,
    });
    progress = await getRenditionProgress(rendition.id);
    expect(progress?.positionMs).toBe(1234);
    expect(progress?.percent).toBe(0);
    expect(progress?.completed).toBe(false);
    expect(await driver.all('SELECT * FROM rendition_progress')).toHaveLength(1);
  });

  it('isRenditionDownloaded requires every segment to be ready with a file path', async () => {
    await upsertCatalogueBook(book('b1'));
    const rendition = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'plain',
      length: '15',
    });
    expect(await isRenditionDownloaded(rendition.id)).toBe(false);

    const segments = await replaceSegments(rendition.id, [
      segment('one', 'k1'),
      segment('two', 'k2'),
    ]);
    await updateSegment(segments[0].id, { status: 'ready', filePath: '/a.wav' });
    expect(await isRenditionDownloaded(rendition.id)).toBe(false);
    await updateSegment(segments[1].id, { status: 'ready', filePath: '/b.wav' });
    expect(await isRenditionDownloaded(rendition.id)).toBe(true);

    // Device-engine renditions are ready but never downloaded when file_path is null.
    const device = await getOrCreateRendition({
      bookId: 'b1',
      language: 'fr',
      styleId: 'plain',
      length: '15',
    });
    const deviceSegments = await replaceSegments(device.id, [segment('one', 'k1')]);
    await updateSegment(deviceSegments[0].id, { status: 'ready', filePath: null });
    expect(await isRenditionDownloaded(device.id)).toBe(false);
  });

  it('deleting a rendition cascades its segments and progress', async () => {
    await upsertCatalogueBook(book('b1'));
    const rendition = await getOrCreateRendition({
      bookId: 'b1',
      language: 'en',
      styleId: 'plain',
      length: '15',
    });
    await replaceSegments(rendition.id, [segment('one', 'k1')]);
    await saveRenditionProgress({
      renditionId: rendition.id,
      positionMs: 1,
      percent: 0.1,
      completed: false,
    });
    await deleteRendition(rendition.id);
    expect(await listRenditions('b1')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM rendition_segments')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM rendition_progress')).toHaveLength(0);
  });

  it('lists a reading-only in-progress row with a null rendition', async () => {
    await upsertCatalogueBook(book('b1'));
    await setInLibrary('b1', true);
    await getOrCreateRendition({ bookId: 'b1', language: 'en', styleId: 'plain', length: '15' });
    await saveReadingPosition({
      bookId: 'b1',
      locator: '{}',
      percent: 0.4,
      sectionTitle: 'One',
      updatedAt: 100,
    });

    const entries = await listLibraryEntries('in_progress');
    expect(entries).toHaveLength(1);
    expect(entries[0].rendition).toBeNull();
    expect(entries[0].percent).toBeCloseTo(0.4);
    expect(entries[0].positionMs).toBe(0);
  });

  it('lists audio progress, completed and downloaded shelves in order', async () => {
    for (const id of ['b1', 'b2', 'b3']) {
      await upsertCatalogueBook(book(id, `Book ${id}`));
      await setInLibrary(id, true);
    }

    const r1 = await getOrCreateRendition({ bookId: 'b1', language: 'en', styleId: 'plain', length: '15' });
    const r2 = await getOrCreateRendition({ bookId: 'b2', language: 'en', styleId: 'plain', length: '15' });
    const r3 = await getOrCreateRendition({ bookId: 'b3', language: 'en', styleId: 'plain', length: '15' });

    await saveRenditionProgress({ renditionId: r1.id, positionMs: 1000, percent: 0.2, completed: false });
    await driver.run('UPDATE rendition_progress SET updated_at = 100 WHERE rendition_id = ?', [r1.id]);
    await saveRenditionProgress({ renditionId: r2.id, positionMs: 2000, percent: 0.5, completed: false });
    await driver.run('UPDATE rendition_progress SET updated_at = 200 WHERE rendition_id = ?', [r2.id]);
    await driver.run('UPDATE rendition_progress SET updated_at = 300 WHERE rendition_id = ?', [r1.id]);

    const inProgress = await listLibraryEntries('in_progress');
    expect(inProgress.map((e) => e.book.id)).toEqual(['b1', 'b2']);
    expect(inProgress[0].rendition?.id).toBe(r1.id);
    expect(inProgress[0].positionMs).toBe(1000);

    expect(await listLibraryEntries('in_progress', 1)).toHaveLength(1);

    await saveRenditionProgress({ renditionId: r3.id, positionMs: 9000, percent: 1, completed: true });
    const completed = await listLibraryEntries('completed');
    expect(completed.map((e) => e.book.id)).toEqual(['b3']);
    expect(completed[0].completed).toBe(true);

    // r1 is downloaded, r2 is not.
    const segs = await replaceSegments(r1.id, [segment('one', 'k1')]);
    await updateSegment(segs[0].id, { status: 'ready', filePath: '/a.wav' });
    const deviceSegs = await replaceSegments(r2.id, [segment('one', 'k1')]);
    await updateSegment(deviceSegs[0].id, { status: 'ready', filePath: null });

    const downloaded = await listLibraryEntries('downloaded');
    expect(downloaded.map((e) => e.book.id)).toEqual(['b1']);
    expect(downloaded[0].downloaded).toBe(true);
    expect(downloaded[0].rendition?.id).toBe(r1.id);
  });
});
