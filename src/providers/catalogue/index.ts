import { openLibraryProvider } from './openlibrary';
import { gutendexProvider } from './gutendex';
import { googleBooksProvider } from './googlebooks';
import type { CatalogueBook, CataloguePage, CatalogueProvider, CatalogueQuery } from './types';

export const catalogueProviders: Record<string, CatalogueProvider> = {
  openlibrary: openLibraryProvider,
  gutendex: gutendexProvider,
  googlebooks: googleBooksProvider,
};

export const DEFAULT_PROVIDERS = ['gutendex', 'openlibrary'] as const;

/** Merge provider results, de-duplicating by title+author while keeping order. */
export function mergeCataloguePages(pages: CataloguePage[]): CatalogueBook[] {
  const seen = new Set<string>();
  const out: CatalogueBook[] = [];
  for (const page of pages) {
    for (const book of page.books) {
      const key = `${book.title.toLowerCase().trim()}|${(book.author ?? '').toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(book);
    }
  }
  return out;
}

export async function searchCatalogue(
  query: CatalogueQuery,
  providerIds: readonly string[] = DEFAULT_PROVIDERS,
): Promise<{ books: CatalogueBook[]; failures: { provider: string; message: string }[]; attributions: string[] }> {
  const results = await Promise.allSettled(
    providerIds.map((id) => catalogueProviders[id].search(query)),
  );
  const pages: CataloguePage[] = [];
  const failures: { provider: string; message: string }[] = [];
  results.forEach((result, index) => {
    const id = providerIds[index];
    if (result.status === 'fulfilled') pages.push(result.value);
    else failures.push({ provider: id, message: (result.reason as Error)?.message ?? 'Failed' });
  });
  return {
    books: mergeCataloguePages(pages),
    failures,
    attributions: pages.map((p) => p.attribution),
  };
}

/** Sanitise user input for an FTS5 MATCH query. */
export function ftsQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 8);
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

export type { CatalogueBook, CataloguePage, CatalogueProvider, CatalogueQuery };
