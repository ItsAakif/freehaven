import { clearHttpCache } from '@/lib/http';
import { gutendexProvider, mapGutendexBook } from '@/providers/catalogue/gutendex';
import {
  catalogueProviders,
  DEFAULT_PROVIDERS,
  mergeCataloguePages,
  searchCatalogue,
} from '@/providers/catalogue';
import type { CatalogueProvider } from '@/providers/catalogue/types';

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

  it('treats a us-ascii-only row as downloadable public domain', () => {
    const book = mapGutendexBook({
      id: 36,
      title: 'The War of the Worlds',
      formats: {
        'text/plain; charset=us-ascii': 'https://www.gutenberg.org/cache/epub/36/pg36.txt',
      },
      languages: ['en'],
    });
    expect(book?.access).toBe('public_domain');
    expect(book?.epubUrl).toBeNull();
    expect(book?.sourceId).toBe('36');
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

  it('only queries gutendex by default', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn((url: string) => {
      calls.push(url);
      return ok({ count: 0, next: null, results: [] });
    }) as unknown as typeof fetch;

    expect(DEFAULT_PROVIDERS).toEqual(['gutendex']);
    const result = await searchCatalogue({});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('gutendex.com/books');
    expect(result.books).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('survives one provider failing and reports the failure', async () => {
    const stub: CatalogueProvider = {
      id: 'stub',
      label: 'Stub',
      attribution: 'stub',
      canDownload: false,
      search: async () => {
        throw new Error('offline');
      },
    };
    catalogueProviders.stub = stub;
    global.fetch = jest.fn(() =>
      ok({ count: 1, next: null, results: [{ id: 1, title: 'Book', formats: {} }] }),
    ) as unknown as typeof fetch;

    try {
      const result = await searchCatalogue({ q: 'book' }, ['gutendex', 'stub']);
      expect(result.books).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].provider).toBe('stub');
      expect(result.attributions[0]).toMatch(/Gutendex|Gutenberg/);
    } finally {
      delete catalogueProviders.stub;
    }
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
      return ok({ count: 0, next: null, results: [] });
    }) as unknown as typeof fetch;
    const page = await gutendexProvider.search({ q: 'x' });
    expect(page.books).toEqual([]);
    expect(attempts).toBe(2);
  });
});
