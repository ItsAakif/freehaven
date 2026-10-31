/** @jest-environment node */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractDocument } from '@/features/imports/service';
import {
  extractPdfPagesNative,
  pdfUriToFilePath,
  setPdfTextModuleForTests,
} from '@/features/imports/pdfNative';

jest.mock('../../../../modules/pdf-text', () => ({
  isPdfTextAvailable: () => false,
  extractPdfPages: jest.fn(async () => null),
}));

function pageText(label: string): string {
  return `${label} ${'PdfBox sorts glyphs by position and keeps CID text intact. '.repeat(12)}`.trim();
}

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return doc.save();
}

async function readablePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const line = 'The fallback content stream parser should recover these deliberate practice words. '.repeat(4);
  for (let index = 0; index < 3; index += 1) {
    const page = doc.addPage([500, 700]);
    page.drawText(line, { x: 30, y: 650, size: 9, font });
  }
  return doc.save({ useObjectStreams: false });
}

afterEach(() => {
  setPdfTextModuleForTests(null);
});

describe('native PDF wrapper', () => {
  it('returns null when the module is absent', async () => {
    const extractPdfPages = jest.fn(async () => '[]');
    setPdfTextModuleForTests({
      isPdfTextAvailable: () => false,
      extractPdfPages,
    });

    await expect(extractPdfPagesNative('file:///book.pdf')).resolves.toBeNull();
    expect(extractPdfPages).not.toHaveBeenCalled();
  });

  it('parses JSON and strips and decodes the file URI', async () => {
    const extractPdfPages = jest.fn(async () =>
      JSON.stringify([
        { page: 1, text: 'First page' },
        { page: 2, text: 'Second page' },
      ]),
    );
    setPdfTextModuleForTests({
      isPdfTextAvailable: () => true,
      extractPdfPages,
    });

    await expect(
      extractPdfPagesNative('file:///storage/emulated/0/Download/Test%20Book.pdf'),
    ).resolves.toEqual([
      { page: 1, text: 'First page' },
      { page: 2, text: 'Second page' },
    ]);
    expect(extractPdfPages).toHaveBeenCalledWith('/storage/emulated/0/Download/Test Book.pdf');
  });

  it('converts plain and undecodable URIs without throwing', () => {
    expect(pdfUriToFilePath('file:///a%20b.pdf')).toBe('/a b.pdf');
    expect(pdfUriToFilePath('/already/a/path.pdf')).toBe('/already/a/path.pdf');
    expect(pdfUriToFilePath('file:///bad%eth.pdf')).toBe('/bad%eth.pdf');
  });
});

describe('extractDocument native PDF path', () => {
  it('uses injected native pages when present', async () => {
    const extractPdfPages = jest.fn(async () =>
      JSON.stringify([
        { page: 1, text: pageText('Page one') },
        { page: 2, text: pageText('Page two') },
      ]),
    );
    setPdfTextModuleForTests({
      isPdfTextAvailable: () => true,
      extractPdfPages,
    });

    const result = await extractDocument(await blankPdf(), {
      name: 'The Psychology of Money.pdf',
      sourceUri: 'file:///storage/emulated/0/Download/The%20Psychology%20of%20Money.pdf',
    });

    expect(extractPdfPages).toHaveBeenCalledWith(
      '/storage/emulated/0/Download/The Psychology of Money.pdf',
    );
    expect(result.format).toBe('pdf');
    expect(result.title).toBe('The Psychology of Money');
    expect(result.pageCount).toBe(2);
    expect(result.extraction.sections).toHaveLength(2);
    expect(result.extraction.sections[0].text).toContain('PdfBox sorts glyphs');
    expect(result.quality).not.toBe('needs_ocr');
    expect(result.quality).not.toBe('unsupported_media');
  });

  it('falls back to parsePdf when the native call throws', async () => {
    setPdfTextModuleForTests({
      isPdfTextAvailable: () => true,
      extractPdfPages: async () => {
        throw new Error('PDFBox failed');
      },
    });

    const result = await extractDocument(await readablePdf(), {
      name: 'fallback.pdf',
      sourceUri: 'file:///fallback.pdf',
    });

    expect(result.format).toBe('pdf');
    expect(result.pageCount).toBe(3);
    expect(result.extraction.sections[0].text).toContain('fallback content stream parser');
    expect(result.quality).not.toBe('needs_ocr');
  });
});
