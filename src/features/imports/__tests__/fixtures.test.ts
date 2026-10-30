import { decodeBytes } from '@/features/imports/charset';
import { EpubError, parseEpub } from '@/features/imports/epub';
import {
  stripBoilerplateFromRawHtml,
  stripGutenbergBoilerplate,
} from '@/features/imports/gutenberg';
import { htmlToText } from '@/features/imports/html';
import { assessTextQuality } from '@/features/imports/quality';
import { sniffBytes } from '@/features/imports/sniff';
import { splitSentences, chunkText } from '@/domain/text';
import {
  assertFullCoverage,
  planTiers,
  planWindowsH,
} from '@/features/learning/windows';
import {
  emptyBytes,
  endBeforeStartText,
  garbageBytes,
  htmlOnlyBook,
  largeBook,
  latin1TextBytes,
  malformedEpub,
  missingMarkersText,
  pngBytes,
  startOnlyText,
  validEpub,
} from './fixtures/gutenberg';

async function epubCode(bytes: Promise<Uint8Array>): Promise<string | undefined> {
  try {
    await parseEpub(await bytes);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(EpubError);
    return (error as EpubError).code;
  }
}

describe('Gutenberg offline fixtures', () => {
  it('decodes the Latin-1 fixture without replacement characters', () => {
    const bytes = latin1TextBytes();
    expect(sniffBytes(bytes).format).toBe('text');
    const decoded = decodeBytes(bytes);
    expect(decoded.charset).toBe('windows-1252');
    expect(decoded.method).toBe('cp1252-fallback');
    expect(decoded.text).toContain('café');
    expect(decoded.replacementCount).toBe(0);
  });

  it('keeps marker-less text and only removes a Produced by header', () => {
    const result = stripGutenbergBoilerplate(missingMarkersText());
    expect(result.text).not.toContain('Produced by Someone');
    expect(result.warnings).toContain('no_licence_markers');
    expect(result.removedChars).toBeLessThan(400);
  });

  it('cuts after a start-only marker and rejects end-before-start', () => {
    const startOnly = stripGutenbergBoilerplate(startOnlyText());
    expect(startOnly.warnings).toContain('no_end_marker');
    expect(startOnly.text).toContain('It was the best of times');

    const reversed = stripGutenbergBoilerplate(endBeforeStartText());
    expect(reversed.text).toBe(endBeforeStartText());
    expect(reversed.suspiciousCut).toBe(true);
  });

  it('throws exact EPUB codes and accepts font-only obfuscation', async () => {
    expect(await epubCode(malformedEpub('no-container'))).toBe('missing_container');
    expect(await epubCode(malformedEpub('no-opf'))).toBe('missing_opf');
    expect(await epubCode(malformedEpub('bad-spine'))).toBe('malformed_opf');
    expect(await epubCode(malformedEpub('drm'))).toBe('drm_protected');
    expect(await epubCode(malformedEpub('missing-chapter'))).toBe('no_readable_chapters');

    const fontOnly = await parseEpub(await validEpub(['<p>Readable words are here in this chapter.</p>']));
    expect(fontOnly.chapters.length).toBeGreaterThan(0);
  });

  it('cleans an HTML-only book and honours markers inside comments', () => {
    const raw = htmlOnlyBook();
    const { cut } = stripBoilerplateFromRawHtml(raw);
    expect(cut).not.toContain('START OF THE PROJECT GUTENBERG');
    const text = htmlToText(cut);
    expect(text).not.toContain('Contents');
    expect(text).not.toContain('Project Gutenberg footer');
    expect(text).toContain('Attention is the taking possession');
    expect(text).toContain('\n');
    expect(text).toContain('—');
    expect(htmlToText('a &mdash; b &#8212; c')).toBe('a — b — c');
  });

  it('plans a 600k-character book inside the band cap', () => {
    const text = largeBook(600_000);
    const plan = planTiers(text.length);
    expect(['b', 'c']).toContain(plan.band);
    expect(plan.estimatedCalls).toBeLessThanOrEqual(plan.band === 'b' ? 79 : 123);
    const chunks = chunkText(text, { targetChars: 900 });
    const inputs = chunks.map((chunk, index) => ({ id: `c${index}`, text: chunk.text }));
    const windows = planWindowsH(inputs, {
      maxWindows: plan.units0,
      minChars: 4_000,
      maxChars: plan.l0MaxChars,
      hardMaxChars: plan.l0MaxChars,
    });
    assertFullCoverage(windows, inputs.map((input) => input.id));
    for (const window of windows) {
      if (window.chunkIds.length === 1) continue;
      expect(window.charCount).toBeLessThanOrEqual(plan.l0MaxChars);
    }
  });

  it('treats empty and binary payloads as unsupported, never crashing', () => {
    expect(sniffBytes(emptyBytes())).toMatchObject({ format: 'unknown', reason: 'empty' });
    expect(
      assessTextQuality({ text: '', source: 'text', markersFound: false }).verdict,
    ).toBe('unsupported_media');

    expect(() => sniffBytes(pngBytes())).not.toThrow();
    const png = decodeBytes(pngBytes()).text;
    expect(
      assessTextQuality({ text: png, source: 'text', markersFound: false, sniffedFormat: 'image' })
        .verdict,
    ).toBe('unsupported_media');

    const garbage = decodeBytes(garbageBytes()).text;
    expect(
      assessTextQuality({ text: garbage, source: 'text', markersFound: false }).verdict,
    ).toBe('unsupported_media');
  });

  it('splits CJK sentences', () => {
    expect(splitSentences('今日は晴れです。明日は雨です。')).toHaveLength(2);
  });
});
