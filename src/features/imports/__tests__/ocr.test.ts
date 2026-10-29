import {
  DisabledOcrEngine,
  OcrUnavailableError,
  getOcrEngine,
  ocrAvailable,
  orderColumns,
  setOcrEngine,
  type OcrEngine,
} from '@/features/imports/ocr';

describe('OCR adapter', () => {
  afterEach(() => setOcrEngine(new DisabledOcrEngine()));

  it('is explicitly unavailable by default', async () => {
    expect(await ocrAvailable()).toBe(false);
    await expect(getOcrEngine().recognize(new Uint8Array())).rejects.toBeInstanceOf(OcrUnavailableError);
  });

  it('accepts a replacement engine without changing callers', async () => {
    const fake: OcrEngine = {
      id: 'fake',
      label: 'Fake',
      licence: 'MIT',
      isAvailable: async () => true,
      recognize: async (bytes) => ({ text: `decoded ${bytes.length} bytes`, confidence: 99, engine: 'fake' }),
    };
    setOcrEngine(fake);
    expect(await ocrAvailable()).toBe(true);
    const result = await getOcrEngine().recognize(new Uint8Array([1, 2, 3]));
    expect(result.text).toBe('decoded 3 bytes');
  });

  it('restores column order from positioned lines', () => {
    const lines = [
      { text: 'left top', x: 60, y: 100 },
      { text: 'right top', x: 600, y: 100 },
      { text: 'left bottom', x: 60, y: 160 },
      { text: 'right bottom', x: 600, y: 160 },
    ];
    expect(orderColumns(lines, 1000)).toEqual(['left top', 'left bottom', 'right top', 'right bottom']);
  });

  it('keeps full-width lines in visual order', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      text: `a full width line of text number ${i} spanning the page`,
      x: 50,
      y: i * 30,
    }));
    const ordered = orderColumns(lines, 1000);
    expect(ordered[0]).toContain('number 0');
    expect(ordered[9]).toContain('number 9');
  });
});
