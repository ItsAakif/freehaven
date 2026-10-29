import { PDFDocument, StandardFonts } from 'pdf-lib';
import { decodePdfString, extractTextFromContentStream, parsePdf } from '@/features/imports/pdf';

async function buildPdf(useObjectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('A Tiny PDF');
  doc.setAuthor('Test Author');
  const page = doc.addPage([400, 400]);
  page.drawText('Deliberate practice improves performance over time.', { x: 40, y: 320, size: 12, font });
  const second = doc.addPage([400, 400]);
  second.drawText('Spaced repetition strengthens long term memory.', { x: 40, y: 320, size: 12, font });
  return doc.save({ useObjectStreams });
}

describe('PDF extraction', () => {
  it('reads metadata, page count and text from a simple PDF', async () => {
    const parsed = await parsePdf(await buildPdf(false));
    expect(parsed.pageCount).toBe(2);
    expect(parsed.title).toBe('A Tiny PDF');
    expect(parsed.author).toBe('Test Author');
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.pages[0].text).toContain('Deliberate practice');
    expect(parsed.pages[1].text).toContain('Spaced repetition');
    expect(parsed.totalWords).toBeGreaterThan(6);
  });

  it('falls back to stream order when page objects are compressed', async () => {
    const parsed = await parsePdf(await buildPdf(true));
    const joined = parsed.pages.map((p) => p.text).join(' ');
    expect(joined).toContain('Deliberate practice');
    expect(parsed.warnings.join(' ')).toMatch(/page objects|recovered/i);
  });

  it('decodes PDF string escapes and hex strings', () => {
    expect(decodePdfString('Hello \\(world\\)')).toBe('Hello (world)');
    expect(extractTextFromContentStream('BT /F1 12 Tf (Hello) Tj ET')).toBe('Hello');
    expect(extractTextFromContentStream('BT <48656c6c6f> Tj ET')).toBe('Hello');
  });

  it('rejects a PDF with no text layer', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(parsePdf(bytes)).rejects.toThrow(/No text layer/);
  });
});
