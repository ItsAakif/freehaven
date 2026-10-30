import { decodeLatin1 } from '@/features/imports/charset';
import { assessTextQuality } from '@/features/imports/quality';
import { garbageBytes, pngBytes } from './fixtures/gutenberg';

const PROSE = 'Attention is the taking possession of the mind in clear and vivid form. '.repeat(400);

describe('assessTextQuality', () => {
  it('marks substantial prose ready and allows a 25-minute narration', () => {
    const result = assessTextQuality({ text: PROSE, source: 'text', markersFound: true });
    expect(result.verdict).toBe('ready');
    expect(result.metrics.words).toBeGreaterThanOrEqual(3_000);
    expect(result.narration).toEqual({ allowed: true, maxLength: '25', reason: null });
  });

  it('flags a 900-word text as low quality but still narratable at 5 minutes', () => {
    const result = assessTextQuality({ text: 'word '.repeat(900), source: 'text', markersFound: true });
    expect(result.verdict).toBe('low_text_quality');
    expect(result.narration).toEqual({ allowed: true, maxLength: '5', reason: null });
  });

  it('disables narration below 750 words', () => {
    const result = assessTextQuality({ text: 'word '.repeat(400), source: 'text', markersFound: true });
    expect(result.verdict).toBe('low_text_quality');
    expect(result.narration).toEqual({ allowed: false, maxLength: null, reason: 'too_short' });
  });

  it('caps a 2 000-word ready text at 15 minutes', () => {
    const text = 'Attention and memory improve with deliberate practice every day. '.repeat(250);
    const result = assessTextQuality({ text, source: 'text', markersFound: true });
    expect(result.verdict).toBe('ready');
    expect(result.metrics.words).toBeGreaterThanOrEqual(1_800);
    expect(result.metrics.words).toBeLessThan(3_000);
    expect(result.narration.maxLength).toBe('15');
  });

  it('asks for OCR on a scanned PDF', () => {
    const result = assessTextQuality({
      text: 'one two three four five six seven eight nine ten',
      source: 'pdf',
      pageCount: 3,
      markersFound: false,
    });
    expect(result.verdict).toBe('needs_ocr');
    expect(result.narration).toEqual({ allowed: false, maxLength: null, reason: 'needs_ocr' });
  });

  it('rejects image payloads and binary garbage as unsupported media', () => {
    const png = assessTextQuality({
      text: decodeLatin1(pngBytes()),
      source: 'text',
      markersFound: false,
      sniffedFormat: 'image',
    });
    expect(png.verdict).toBe('unsupported_media');

    const garbage = assessTextQuality({
      text: decodeLatin1(garbageBytes()),
      source: 'text',
      markersFound: false,
      sniffedFormat: 'unknown',
    });
    expect(garbage.verdict).toBe('unsupported_media');
  });

  it('detects Arabic script and right-to-left text', () => {
    const text = 'العربية لغة جميلة ومهمة. '.repeat(60);
    const result = assessTextQuality({ text, source: 'text', markersFound: true });
    expect(result.metrics.script).toBe('arabic');
    expect(result.metrics.rtl).toBe(true);
  });

  it('flags CJK text without sentence terminators', () => {
    const result = assessTextQuality({
      text: '今日は晴れです 明日は雨です 明後日は曇りです',
      source: 'text',
      markersFound: true,
    });
    expect(result.metrics.noSentenceBoundaries).toBe(true);
    expect(result.metrics.script).toBe('hiragana');
  });

  it('adds a marker warning without changing the verdict', () => {
    const withMarkers = assessTextQuality({ text: PROSE, source: 'text', markersFound: true });
    const withoutMarkers = assessTextQuality({ text: PROSE, source: 'text', markersFound: false });
    expect(withoutMarkers.verdict).toBe(withMarkers.verdict);
    expect(withoutMarkers.reasons).toContain('no_licence_markers');
    expect(withMarkers.reasons).not.toContain('no_licence_markers');
  });
});
