import { fetchJson } from '@/lib/http';
import type { CatalogueBook, CataloguePage, CatalogueProvider, CatalogueQuery } from './types';

type GutendexAuthor = { name?: string; birth_year?: number; death_year?: number };
type GutendexBook = {
  id: number;
  title: string;
  authors?: GutendexAuthor[];
  formats?: Record<string, string>;
  subjects?: string[];
  bookshelves?: string[];
  languages?: string[];
  download_count?: number;
  media_type?: string;
};

type GutendexResponse = {
  count?: number;
  next?: string | null;
  results?: GutendexBook[];
};

export function mapGutendexBook(book: GutendexBook): CatalogueBook | null {
  if (!book.id || !book.title) return null;
  const formats = book.formats ?? {};
  const epub = formats['application/epub+zip'] ?? null;
  const cover = formats['image/jpeg'] ?? null;
  const text = formats['text/plain; charset=utf-8'] ?? formats['text/plain'] ?? null;
  return {
    id: `gutendex:${book.id}`,
    provider: 'gutendex',
    title: book.title,
    subtitle: null,
    author: book.authors?.map((a) => a.name).filter(Boolean).join(', ') || null,
    description: null,
    coverUrl: cover,
    language: book.languages?.[0] ?? null,
    isbn13: null,
    publisher: 'Project Gutenberg',
    publishedYear: null,
    pageCount: null,
    subjects: (book.subjects ?? []).slice(0, 6),
    source: 'gutenberg',
    sourceId: String(book.id),
    license: 'Public domain (Project Gutenberg)',
    access: epub || text ? 'public_domain' : 'metadata',
    externalUrl: `https://www.gutenberg.org/ebooks/${book.id}`,
    epubUrl: epub,
  };
}

export const gutendexProvider: CatalogueProvider = {
  id: 'gutendex',
  label: 'Project Gutenberg',
  attribution: 'Public-domain ebooks from Project Gutenberg via the Gutendex API.',
  canDownload: true,
  async search(query: CatalogueQuery): Promise<CataloguePage> {
    const page = Math.max(1, query.page ?? 1);
    const params = new URLSearchParams({ page: String(page) });
    if (query.isbn) params.set('search', query.isbn);
    else if (query.q) params.set('search', query.q);
    else if (query.subject) params.set('topic', query.subject);
    else params.set('sort', 'popular');
    if (query.language) params.set('languages', query.language);

    const data = await fetchJson<GutendexResponse>(`https://gutendex.com/books?${params.toString()}`, {
      cacheTtlMs: 10 * 60_000,
    });
    const books = (data.results ?? [])
      .map(mapGutendexBook)
      .filter((b): b is CatalogueBook => !!b);
    return {
      books,
      page,
      hasMore: !!data.next,
      total: data.count,
      provider: this.id,
      attribution: this.attribution,
    };
  },
};
