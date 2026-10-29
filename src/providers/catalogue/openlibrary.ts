import { fetchJson } from '@/lib/http';
import type { CatalogueBook, CataloguePage, CatalogueProvider, CatalogueQuery } from './types';

type OpenLibraryDoc = {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
  language?: string[];
  publisher?: string[];
  subject?: string[];
  number_of_pages_median?: number;
  public_scan_b?: boolean;
  ia?: string[];
};

type OpenLibraryResponse = {
  numFound?: number;
  start?: number;
  docs?: OpenLibraryDoc[];
};

const FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'cover_i',
  'isbn',
  'language',
  'publisher',
  'subject',
  'number_of_pages_median',
  'public_scan_b',
  'ia',
].join(',');

export function mapOpenLibraryDoc(doc: OpenLibraryDoc): CatalogueBook | null {
  if (!doc.key || !doc.title) return null;
  const cover = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null;
  const iaId = doc.ia?.[0];
  return {
    id: `openlibrary:${doc.key.replace(/^\//, '')}`,
    provider: 'openlibrary',
    title: doc.title,
    subtitle: doc.subtitle ?? null,
    author: doc.author_name?.slice(0, 3).join(', ') ?? null,
    description: null,
    coverUrl: cover,
    language: doc.language?.[0] ?? null,
    isbn13: doc.isbn?.find((i) => i.length === 13) ?? doc.isbn?.[0] ?? null,
    publisher: doc.publisher?.[0] ?? null,
    publishedYear: doc.first_publish_year ?? null,
    pageCount: doc.number_of_pages_median ?? null,
    subjects: (doc.subject ?? []).slice(0, 6),
    source: 'catalogue',
    sourceId: doc.key,
    license: 'Metadata: Open Library (CC0 where stated)',
    // Open Library grants discovery, not download rights. Scanned copies link out.
    access: iaId && doc.public_scan_b ? 'external' : 'metadata',
    externalUrl: iaId ? `https://archive.org/details/${iaId}` : `https://openlibrary.org${doc.key}`,
    epubUrl: null,
  };
}

export const openLibraryProvider: CatalogueProvider = {
  id: 'openlibrary',
  label: 'Open Library',
  attribution: 'Search results from Open Library (openlibrary.org). Covers © their publishers.',
  canDownload: false,
  async search(query: CatalogueQuery): Promise<CataloguePage> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, query.limit ?? 20);
    const params = new URLSearchParams({
      fields: FIELDS,
      page: String(page),
      limit: String(limit),
    });
    if (query.isbn) params.set('q', `isbn:${query.isbn}`);
    else if (query.q) params.set(query.subject ? 'subject' : 'q', query.subject ?? query.q);
    else if (query.subject) params.set('subject', query.subject);
    else params.set('q', 'subject:fiction');

    const data = await fetchJson<OpenLibraryResponse>(
      `https://openlibrary.org/search.json?${params.toString()}`,
      { cacheTtlMs: 10 * 60_000 },
    );
    const books = (data.docs ?? [])
      .map(mapOpenLibraryDoc)
      .filter((b): b is CatalogueBook => !!b);
    const total = data.numFound ?? 0;
    return {
      books,
      page,
      hasMore: page * limit < total,
      total,
      provider: this.id,
      attribution: this.attribution,
    };
  },
};
