import { fetchJson } from '@/lib/http';
import type { CatalogueBook, CataloguePage, CatalogueProvider, CatalogueQuery } from './types';

type GoogleVolume = {
  id: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    categories?: string[];
    language?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    previewLink?: string;
    infoLink?: string;
  };
};

type GoogleResponse = { totalItems?: number; items?: GoogleVolume[] };

export function mapGoogleVolume(volume: GoogleVolume): CatalogueBook | null {
  const info = volume.volumeInfo;
  if (!volume.id || !info?.title) return null;
  const year = info.publishedDate ? Number(info.publishedDate.slice(0, 4)) : null;
  const isbn13 = info.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier ?? null;
  return {
    id: `googlebooks:${volume.id}`,
    provider: 'googlebooks',
    title: info.title,
    subtitle: info.subtitle ?? null,
    author: info.authors?.slice(0, 3).join(', ') ?? null,
    description: info.description ?? null,
    coverUrl: (info.imageLinks?.thumbnail ?? null)?.replace('http://', 'https://') ?? null,
    language: info.language ?? null,
    isbn13,
    publisher: info.publisher ?? null,
    publishedYear: Number.isFinite(year) ? year : null,
    pageCount: info.pageCount ?? null,
    subjects: (info.categories ?? []).slice(0, 6),
    source: 'catalogue',
    sourceId: volume.id,
    license: 'Metadata: Google Books',
    access: info.previewLink ? 'preview' : 'metadata',
    externalUrl: info.infoLink ?? info.previewLink ?? null,
    epubUrl: null,
  };
}

export const googleBooksProvider: CatalogueProvider = {
  id: 'googlebooks',
  label: 'Google Books',
  attribution: 'Metadata and previews from Google Books. Preview availability varies by title.',
  canDownload: false,
  async search(query: CatalogueQuery): Promise<CataloguePage> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(40, query.limit ?? 20);
    const q = query.isbn
      ? `isbn:${query.isbn}`
      : query.q
        ? query.q
        : query.subject
          ? `subject:${query.subject}`
          : 'subject:education';
    const params = new URLSearchParams({
      q,
      maxResults: String(limit),
      startIndex: String((page - 1) * limit),
      printType: 'books',
    });
    const data = await fetchJson<GoogleResponse>(
      `https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
      { cacheTtlMs: 10 * 60_000 },
    );
    const books = (data.items ?? [])
      .map(mapGoogleVolume)
      .filter((b): b is CatalogueBook => !!b);
    const total = data.totalItems ?? 0;
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
