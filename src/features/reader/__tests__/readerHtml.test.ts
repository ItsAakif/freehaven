import {
  applyHighlights,
  buildReaderHtml,
  decodeLocator,
  encodeLocator,
  escapeHtml,
  splitParagraphs,
  DEFAULT_READER_SETTINGS,
} from '@/features/reader/readerHtml';

describe('reader HTML', () => {
  it('escapes untrusted text', () => {
    expect(escapeHtml('<script>alert(1)</script> & "x"')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;',
    );
  });

  it('wraps highlight ranges and ignores invalid ones', () => {
    const html = applyHighlights('hello brave world', [
      { id: 'h1', para: 0, start: 6, end: 11, color: 'gold' },
      { id: 'h2', para: 0, start: 10, end: 4, color: 'gold' },
    ]);
    expect(html).toContain('<mark data-id="h1" class="hl hl-gold">brave</mark>');
    expect(html).toContain('hello ');
    expect(html).not.toContain('data-id="h2"');
  });

  it('splits paragraphs and preserves the text', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird.';
    const paragraphs = splitParagraphs(text);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs.join(' ')).toContain('Second paragraph here.');
  });

  it('renders a self-contained document with the bridge', () => {
    const html = buildReaderHtml({
      title: 'Book',
      sectionTitle: 'Chapter 1',
      paragraphs: ['One paragraph.', 'Two paragraph.'],
      highlights: [{ id: 'h1', para: 1, start: 0, end: 3, color: 'moss' }],
      settings: DEFAULT_READER_SETTINGS,
    });
    expect(html).toContain('data-p="0"');
    expect(html).toContain('<mark data-id="h1" class="hl hl-moss">Two</mark>');
    expect(html).toContain('ReactNativeWebView');
    expect(html).toContain('selectionchange');
  });

  it('round-trips locators', () => {
    const locator = { sectionId: 's1', para: 3, start: 4, end: 9, quote: 'hello' };
    expect(decodeLocator(encodeLocator(locator))).toEqual(locator);
    expect(decodeLocator('not json')).toBeNull();
    expect(decodeLocator(null)).toBeNull();
  });
});
