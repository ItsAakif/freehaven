/** @jest-environment node */
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { upsertCatalogueBook } from '@/data/repositories/books';
import {
  getDocument,
  listChunks,
  replaceExtraction,
  saveDocument,
  searchBookChunks,
} from '@/data/repositories/reading';
import { buildExtraction } from '@/features/imports/service';

describe('import persistence', () => {
  let driver: ReturnType<typeof createTestDriver>;

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await upsertCatalogueBook({
      id: 'import:abc',
      provider: 'gutenberg',
      title: 'Imported Book',
      subjects: [],
      source: 'import',
      sourceId: 'abc',
      access: 'user_import',
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

  it('persists sections and chunks under the exact saved document id', async () => {
    const documentId = 'doc-fixed';
    const extraction = buildExtraction(
      'epub',
      {
        kind: 'epub',
        chapters: [
          {
            title: 'One',
            href: 'c1.xhtml',
            html: '<p>One</p>',
            text: 'Attention is the selective allocation of processing resources. '.repeat(8),
          },
        ],
      },
      documentId,
    );

    expect(extraction.documentId).toBe(documentId);

    await saveDocument({
      id: documentId,
      bookId: 'import:abc',
      format: 'epub',
      filePath: null,
      fileSize: 0,
      pageCount: null,
      wordCount: extraction.words,
      status: 'ready',
      error: null,
      extractor: 'test',
      importedAt: 0,
    });
    await replaceExtraction(documentId, extraction.sections, extraction.chunks);

    expect(await listChunks(documentId)).not.toHaveLength(0);
    expect(await searchBookChunks('import:abc', 'attention')).not.toHaveLength(0);
  });

  it('persists the quality verdict and extractor tag without a schema change', async () => {
    await saveDocument({
      id: 'doc-quality',
      bookId: 'import:abc',
      format: 'text',
      filePath: null,
      fileSize: 0,
      pageCount: null,
      wordCount: 12,
      status: 'ready',
      error: 'low_text_quality',
      extractor: 'gutenberg:text:utf-8:latin',
      importedAt: 1,
    });

    const document = await getDocument('import:abc');
    expect(document?.status).toBe('ready');
    expect(document?.error).toBe('low_text_quality');
    expect(document?.extractor).toBe('gutenberg:text:utf-8:latin');
  });
});
