import { fetchJson } from '@/lib/http';
import {
  resolveGutenbergSources,
  sourcesFromFormats,
  synthesiseGutenbergSources,
} from '@/features/imports/gutenbergSources';

jest.mock('@/lib/http', () => ({
  fetchJson: jest.fn(),
}));

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;

const FULL_FORMATS: Record<string, string> = {
  'application/epub+zip': 'https://example.test/book.epub',
  'text/plain; charset=utf-8': 'https://example.test/book-utf8.txt',
  'text/plain; charset=us-ascii': 'https://example.test/book-ascii.txt',
  'text/plain': 'https://example.test/book.txt',
  'text/html; charset=utf-8': 'https://example.test/book-utf8.html',
  'text/html; charset=us-ascii': 'https://example.test/book-ascii.html',
  'application/x-mobipocket-ebook': 'https://example.test/book.mobi',
  'application/rdf+xml': 'https://example.test/book.rdf',
  'audio/mpeg': 'https://example.test/book.mp3',
  'image/jpeg': 'https://example.test/cover.jpg',
};

describe('sourcesFromFormats', () => {
  it('produces the six-step order and ignores audio/image/metadata formats', () => {
    const sources = sourcesFromFormats(FULL_FORMATS);
    expect(sources.map((source) => source.kind)).toEqual([
      'epub',
      'text-utf8',
      'text-ascii',
      'text-utf8',
      'html',
      'html',
    ]);
    expect(sources.map((source) => source.url)).not.toContain('https://example.test/book.mp3');
    expect(sources.map((source) => source.url)).not.toContain('https://example.test/cover.jpg');
    expect(sources[0].declaredCharset).toBeNull();
    expect(sources[1].declaredCharset).toBe('utf-8');
    expect(sources[2].declaredCharset).toBe('us-ascii');
  });

  it('yields text candidates for a row with no EPUB', () => {
    const sources = sourcesFromFormats({
      'text/plain; charset=utf-8': 'https://example.test/a.txt',
      'text/html': 'https://example.test/a.html',
    });
    expect(sources.map((source) => source.kind)).toEqual(['text-utf8', 'html']);
  });

  it('matches keys case-insensitively', () => {
    const sources = sourcesFromFormats({ 'TEXT/PLAIN; CHARSET=UTF-8': 'https://example.test/x' });
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe('text-utf8');
  });

  it('returns nothing for missing formats', () => {
    expect(sourcesFromFormats(undefined)).toEqual([]);
  });
});

describe('synthesiseGutenbergSources', () => {
  it('builds deterministic EPUB, text and HTML URLs', () => {
    expect(synthesiseGutenbergSources('2600')).toEqual([
      {
        kind: 'epub',
        url: 'https://www.gutenberg.org/ebooks/2600.epub3.images',
        declaredCharset: null,
        label: 'EPUB (synthesised)',
      },
      {
        kind: 'text-utf8',
        url: 'https://www.gutenberg.org/cache/epub/2600/pg2600.txt',
        declaredCharset: null,
        label: 'Plain text (synthesised)',
      },
      {
        kind: 'html',
        url: 'https://www.gutenberg.org/cache/epub/2600/pg2600-images.html',
        declaredCharset: null,
        label: 'HTML (synthesised)',
      },
    ]);
    expect(synthesiseGutenbergSources('')).toEqual([]);
  });
});

describe('resolveGutenbergSources', () => {
  beforeEach(() => mockFetchJson.mockReset());

  it('prepends the row EPUB, adds Gutendex sources and appends synthesised URLs', async () => {
    mockFetchJson.mockResolvedValue({ formats: { 'text/html': 'https://example.test/book.html' } });
    const { sources, resolvedFrom } = await resolveGutenbergSources({
      sourceId: '2600',
      epubUrl: 'https://example.test/row.epub',
    });
    expect(resolvedFrom).toBe('gutendex');
    expect(sources[0]).toMatchObject({ kind: 'epub', url: 'https://example.test/row.epub' });
    expect(sources.map((source) => source.url)).toContain('https://example.test/book.html');
    expect(sources.map((source) => source.url)).toContain(
      'https://www.gutenberg.org/cache/epub/2600/pg2600.txt',
    );
  });

  it('de-duplicates by exact URL', async () => {
    mockFetchJson.mockResolvedValue({
      formats: { 'application/epub+zip': 'https://example.test/row.epub' },
    });
    const { sources } = await resolveGutenbergSources({
      sourceId: '2600',
      epubUrl: 'https://example.test/row.epub',
    });
    const urls = sources.map((source) => source.url);
    expect(urls.filter((url) => url === 'https://example.test/row.epub')).toHaveLength(1);
  });

  it('falls back to synthesised sources when Gutendex fails', async () => {
    mockFetchJson.mockRejectedValue(new Error('offline'));
    const { sources, resolvedFrom } = await resolveGutenbergSources({
      sourceId: '135',
      epubUrl: null,
    });
    expect(resolvedFrom).toBe('synthesised');
    expect(sources).toHaveLength(3);
    expect(sources[0].kind).toBe('epub');
  });

  it('reports the row source when there is no numeric id', async () => {
    const { sources, resolvedFrom } = await resolveGutenbergSources({
      sourceId: null,
      epubUrl: 'https://example.test/row.epub',
    });
    expect(resolvedFrom).toBe('row');
    expect(sources).toHaveLength(1);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('is deterministic for the same input', async () => {
    mockFetchJson.mockResolvedValue({ formats: FULL_FORMATS });
    const first = await resolveGutenbergSources({ sourceId: '1', epubUrl: null });
    const second = await resolveGutenbergSources({ sourceId: '1', epubUrl: null });
    expect(second).toEqual(first);
  });
});
