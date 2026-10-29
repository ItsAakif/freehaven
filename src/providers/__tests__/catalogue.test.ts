import { clearHttpCache } from '@/lib/http';
import {
  mapGutendexBook,
  gutendexProvider,
} from '@/providers/catalogue/gutendex';
import { mapOpenLibraryDoc, openLibraryProvider } from '@/providers/catalogue/openlibrary';
import { mapGoogleVolume } from '@/providers/catalogue/googlebooks';
import { mergeCataloguePages, searchCatalogue } from '@/providers/catalogue';

const originalFetch = global.fetch;
const ok = (payload: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => payload,
    headers: { get: () => 'application/json' },
  } as unknown as Response);

beforeEach(() => {
  clearHttpCache();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('catalogue providers', () => {
  it('normalises an Open Library document and marks access correctly', () => {
    const book = mapOpenLibraryDoc({
      key: '/works/OL123W',
      title: 'Meditations',
      author_name: ['Marcus Aurelius'],
      first_publish_year: 180,
      cover_i: 42,
      isbn: ['9780140449334'],
      public_scan_b: true,
      ia: ['meditations00marc'],
      subject: ['Philosophy', 'Stoicism'],
    });
    expect(book?.id).toBe('openlibrary:works/OL123W');
    expect(book?.coverUrl).toContain('covers.openlibrary.org');
    expect(book?.access).toBe('external');
    expect(book?.externalUrl).toContain('archive.org');
    expect(book?.epubUrl).toBeNull();
  });

  it('normalises a Gutendex book with a downloadable EPUB', () => {
    const book = mapGutendexBook({
      id: 1342,
      title: 'Pride and Prejudice',
      authors: [{ name: 'Austen, Jane' }],
      formats: {
        'application/epub+zip': 'https://www.gutenberg.org/ebooks/1342.epub.images',
        'image/jpeg': 'https://www.gutenberg.org/cache/1342.jpg',
      },
      subjects: ['Courtship'],
      languages: ['en'],
    });
    expect(book?.id).toBe('gutendex:1342');
    expect(book?.access).toBe('public_domain');
    expect(book?.epubUrl).toContain('.epub');
    expect(book?.license).toMatch(/Public domain/);
  });

  it('normalises a Google Books volume as preview metadata only', () => {
    const book = mapGoogleVolume({
      id: 'abc',
      volumeInfo: {
        title: 'Thinking, Fast and Slow',
        authors: ['Daniel Kahneman'],
        publishedDate: '2011-10-25',
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780374533557' }],
        imageLinks: { thumbnail: 'http://books.google.com/x.jpg' },
        previewLink: 'https://books.google.com/preview',
      },
    });
    expect(book?.access).toBe('preview');
    expect(book?.publishedYear).toBe(2011);
    expect(book?.coverUrl?.startsWith('https://')).toBe(true);
    expect(book?.epubUrl).toBeNull();
  });

  it('merges results and de-duplicates by title and author', () => {
    const merged = mergeCataloguePages([
      {
        provider: 'a',
        page: 1,
        hasMore: false,
        attribution: 'a',
        books: [
          { id: '1', title: 'Same Book', author: 'A', provider: 'a', source: 'catalogue', sourceId: '1', subjects: [], access: 'metadata' },
        ],
      },
      {
        provider: 'b',
        page: 1,
        hasMore: false,
        attribution: 'b',
        books: [
          { id: '2', title: 'same book', author: 'a', provider: 'b', source: 'catalogue', sourceId: '2', subjects: [], access: 'metadata' },
          { id: '3', title: 'Other', author: 'B', provider: 'b', source: 'catalogue', sourceId: '3', subjects: [], access: 'metadata' },
        ],
      },
    ]);
    expect(merged.map((b) => b.id)).toEqual(['1', '3']);
  });

  it('survives one provider failing and reports the failure', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url.includes('gutendex')) return ok({ count: 1, next: null, results: [{ id: 1, title: 'Book', formats: {} }] });
      return Promise.reject(new Error('offline'));
    }) as unknown as typeof fetch;

    const result = await searchCatalogue({ q: 'book' }, ['gutendex', 'openlibrary']);
    expect(result.books).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].provider).toBe('openlibrary');
    expect(result.attributions[0]).toMatch(/Gutendex|Gutenberg/);
  });

  it('builds provider URLs with pagination and language filters', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn((url: string) => {
      calls.push(url);
      return ok({ count: 0, next: null, results: [] });
    }) as unknown as typeof fetch;
    await gutendexProvider.search({ q: 'stoicism', page: 2, language: 'en' });
    expect(calls[0]).toContain('search=stoicism');
    expect(calls[0]).toContain('page=2');
    expect(calls[0]).toContain('languages=en');
  });

  it('retries a failing request before giving up', async () => {
    let attempts = 0;
    global.fetch = jest.fn(() => {
      attempts += 1;
      if (attempts < 2) return Promise.reject(new Error('temporary'));
      return ok({ numFound: 0, docs: [] });
    }) as unknown as typeof fetch;
    const page = await openLibraryProvider.search({ q: 'x' });
    expect(page.books).toEqual([]);
    expect(attempts).toBe(2);
  });
});
