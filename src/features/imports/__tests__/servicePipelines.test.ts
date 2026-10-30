/** @jest-environment node */
import { PDFDocument } from 'pdf-lib';
import { File } from 'expo-file-system';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { getDocument, listChunks } from '@/data/repositories/reading';
import {
  ImportFailure,
  detectFormat,
  downloadGutenbergBook,
  extractDocument,
  importBytes,
} from '@/features/imports/service';
import {
  htmlOnlyBook,
  latin1HtmlWithMeta,
  latin1TextBytes,
  pngBytes,
  validEpub,
} from './fixtures/gutenberg';

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => ch.charCodeAt(0) & 0xff));
}

function htmlProse(words = 4_000): string {
  const sentence = 'Attention is the taking possession of the mind in clear and vivid form. ';
  const paragraph = `<p>${sentence.repeat(20)}</p>`;
  return `<!doctype html><html><head><title>Long Prose</title></head><body>
<!-- *** START OF THE PROJECT GUTENBERG EBOOK LONG PROSE *** -->
${paragraph.repeat(Math.ceil(words / 260))}
<!-- *** END OF THE PROJECT GUTENBERG EBOOK LONG PROSE *** -->
</body></html>`;
}

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return doc.save();
}

describe('detectFormat', () => {
  it('accepts .html/.htm as text', () => {
    expect(detectFormat('book.html')).toBe('text');
    expect(detectFormat('book.HTM')).toBe('text');
    expect(detectFormat('book.epub')).toBe('epub');
    expect(detectFormat('photo.jpg', 'image/jpeg')).toBeNull();
  });
});

describe('extractDocument dispatch', () => {
  it('imports an HTML-only book and drops page furniture', async () => {
    const result = await extractDocument(ascii(htmlOnlyBook()), { name: 'html-only.html' });
    expect(result.format).toBe('text');
    expect(result.sourceFormat).toBe('html');
    expect(result.title).toBe('An HTML-only Book');
    expect(result.quality).not.toBe('unsupported_media');
    const text = result.extraction.sections[0].text;
    expect(text).toContain('Attention is the taking possession');
    expect(text).not.toContain('Contents');
    expect(text).not.toContain('Project Gutenberg footer');
    expect(text).not.toContain('START OF');
  });

  it('sniffs HTML even when the URL name says .txt', async () => {
    const result = await extractDocument(ascii(htmlOnlyBook()), {
      name: 'pg2600.txt',
      mimeType: 'text/plain; charset=utf-8',
    });
    expect(result.sourceFormat).toBe('html');
    expect(result.extraction.sections[0].text).toContain('Attention is the taking possession');
  });

  it('imports a windows-1252 text with accents intact', async () => {
    const result = await extractDocument(latin1TextBytes(), { name: 'latin1.txt' });
    expect(result.charset).toBe('windows-1252');
    const text = result.extraction.sections[0].text;
    expect(text).toContain('café');
    expect(text).toContain('naïve');
  });

  it('imports a windows-1252 HTML page', async () => {
    const result = await extractDocument(latin1HtmlWithMeta(), { name: 'latin1.html' });
    expect(result.charset).toBe('windows-1252');
    expect(result.extraction.sections[0].text).toContain('café');
    expect(result.extraction.sections[0].text).toContain('“Quoted”');
  });

  it('reports a scanned PDF as needs_ocr instead of nonsense', async () => {
    const result = await extractDocument(await blankPdf(), { name: 'scan.pdf' });
    expect(result.quality).toBe('needs_ocr');
    expect(result.narration.allowed).toBe(false);
  });

  it('reports an image payload as unsupported media', async () => {
    const result = await extractDocument(pngBytes(), { name: 'cover.png' });
    expect(result.quality).toBe('unsupported_media');
  });

  it('keeps the normal EPUB path working', async () => {
    const result = await extractDocument(
      await validEpub(['<p>First chapter words are here for reading.</p>', '<p>Second chapter words are here too.</p>']),
      { name: 'book.epub' },
    );
    expect(result.format).toBe('epub');
    expect(result.sourceFormat).toBe('epub');
    expect(result.extraction.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.quality).not.toBe('unsupported_media');
  });
});

describe('importBytes persistence', () => {
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
      /* closed */
    }
  });

  it('stores the quality tag and extractor tag for a readable HTML book', async () => {
    const result = await importBytes({
      bookId: 'gutendex:2600',
      name: 'pg2600.html',
      mimeType: 'text/html',
      bytes: ascii(htmlProse(4_000)),
      origin: 'gutenberg',
      filePath: null,
      fileSize: 0,
    });
    expect(result.quality).toBe('ready');
    expect(result.narrationEligible.maxLength).toBe('25');

    const document = await getDocument('gutendex:2600');
    expect(document?.status).toBe('ready');
    expect(document?.error).toBeNull();
    expect(document?.extractor).toBe('gutenberg:text:utf-8:latin');
    expect(await listChunks(document!.id)).not.toHaveLength(0);
  });

  it('marks low quality ready but records the verdict code', async () => {
    const result = await importBytes({
      bookId: 'gutendex:short',
      name: 'short.html',
      mimeType: 'text/html',
      bytes: ascii('<html><body><p>word '.repeat(300) + '</p></body></html>'),
      origin: 'gutenberg',
      filePath: null,
      fileSize: 0,
    });
    expect(result.quality).toBe('low_text_quality');
    const document = await getDocument('gutendex:short');
    expect(document?.status).toBe('ready');
    expect(document?.error).toBe('low_text_quality');
  });

  it('never leaves a ready document for an image payload', async () => {
    await expect(
      importBytes({
        bookId: 'gutendex:image',
        name: 'cover.png',
        mimeType: 'image/png',
        bytes: pngBytes(),
        origin: 'gutenberg',
        filePath: null,
        fileSize: 0,
      }),
    ).rejects.toBeInstanceOf(ImportFailure);

    const document = await getDocument('gutendex:image');
    expect(document?.status).toBe('failed');
    expect(document?.error).toBe('unsupported_media');
    expect(await listChunks(document!.id)).toHaveLength(0);
  });

  it('never leaves a ready document for a scanned PDF', async () => {
    await expect(
      importBytes({
        bookId: 'gutendex:scan',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        bytes: await blankPdf(),
        origin: 'gutenberg',
        filePath: null,
        fileSize: 0,
      }),
    ).rejects.toMatchObject({ quality: 'needs_ocr' });

    const document = await getDocument('gutendex:scan');
    expect(document?.status).toBe('failed');
    expect(document?.error).toBe('needs_ocr');
  });
});

describe('downloadGutenbergBook source chain', () => {
  let driver: ReturnType<typeof createTestDriver>;
  const fileApi = File as unknown as { downloadFileAsync: jest.Mock };

  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    fileApi.downloadFileAsync = jest.fn();
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* closed */
    }
  });

  it('tries every candidate and throws one clear error', async () => {
    fileApi.downloadFileAsync.mockRejectedValue(new Error('Request failed with status code 404'));
    const sources = [
      { kind: 'epub' as const, url: 'https://example.test/a.epub', declaredCharset: null, label: 'EPUB' },
      { kind: 'text-utf8' as const, url: 'https://example.test/a.txt', declaredCharset: null, label: 'Text' },
    ];
    await expect(downloadGutenbergBook('gutendex:missing', { sources })).rejects.toMatchObject({
      name: 'ImportFailure',
      reasons: ['epub: http_404', 'text-utf8: http_404'],
    });
    expect(fileApi.downloadFileAsync).toHaveBeenCalledTimes(2);
  });

  it('records unsupported_media when every candidate is an image', async () => {
    fileApi.downloadFileAsync.mockResolvedValue({
      uri: 'file:///fake/download',
      bytes: async () => pngBytes(),
    });
    await expect(
      downloadGutenbergBook('gutendex:image-only', {
        sources: [
          { kind: 'html' as const, url: 'https://example.test/a.html', declaredCharset: null, label: 'HTML' },
        ],
      }),
    ).rejects.toMatchObject({ quality: 'unsupported_media' });
  });

  it('does not attempt a download when there is no source at all', async () => {
    await expect(
      downloadGutenbergBook('gutendex:none', { sources: [] }),
    ).rejects.toMatchObject({ quality: 'unsupported_media' });
    // `sources: []` falls back to row/Gutendex resolution; with no row id the
    // chain is empty and no File call happens.
    expect(fileApi.downloadFileAsync).not.toHaveBeenCalled();
  });
});
