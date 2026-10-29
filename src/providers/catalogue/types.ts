import type { BookAccess, BookSource } from '@/domain/types';

export type CatalogueQuery = {
  q?: string;
  subject?: string;
  page?: number;
  limit?: number;
  language?: string;
  /** ISO 8601 / ISBN lookup. */
  isbn?: string;
};

export type CatalogueBook = {
  /** Stable id prefixed with the provider, e.g. `gutendex:1342`. */
  id: string;
  provider: string;
  title: string;
  subtitle?: string | null;
  author?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  language?: string | null;
  isbn13?: string | null;
  publisher?: string | null;
  publishedYear?: number | null;
  pageCount?: number | null;
  subjects: string[];
  source: BookSource;
  sourceId: string;
  license?: string | null;
  access: BookAccess;
  externalUrl?: string | null;
  epubUrl?: string | null;
};

export type CataloguePage = {
  books: CatalogueBook[];
  page: number;
  hasMore: boolean;
  total?: number;
  provider: string;
  attribution: string;
};

export interface CatalogueProvider {
  id: string;
  label: string;
  attribution: string;
  /** Public-domain downloads are the only books Freehaven may host. */
  canDownload: boolean;
  search(query: CatalogueQuery, signal?: AbortSignal): Promise<CataloguePage>;
}
