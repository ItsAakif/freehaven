/**
 * Candidate URL chain for a Gutenberg catalogue row.
 *
 * Gutendex `formats` keys are hints: some rows have no EPUB, some lie about
 * charset, and offline rows have no formats at all. This module builds an
 * ordered, de-duplicated chain that the importer sniffs and falls back through.
 */

import { fetchJson } from '../../lib/http';

export type GutenbergSourceKind = 'epub' | 'text-utf8' | 'text-ascii' | 'html';

export type GutenbergSource = {
  kind: GutenbergSourceKind;
  url: string;
  declaredCharset: string | null;
  label: string;
};

type GutendexBook = {
  formats?: Record<string, string>;
};

function normalisedEntries(formats: Record<string, string> | undefined): [string, string][] {
  if (!formats) return [];
  return Object.entries(formats)
    .filter(([, url]) => typeof url === 'string' && !!url)
    .map(([key, url]) => [key.trim().toLowerCase().replace(/\s+/g, ' '), url] as [string, string]);
}

function findUrl(entries: [string, string][], keys: string[]): string | null {
  for (const key of keys) {
    const hit = entries.find(([entryKey]) => entryKey === key);
    if (hit) return hit[1];
  }
  return null;
}

export function sourcesFromFormats(formats: Record<string, string> | undefined): GutenbergSource[] {
  const entries = normalisedEntries(formats);
  const sources: GutenbergSource[] = [];
  const seen = new Set<string>();

  const add = (
    kind: GutenbergSourceKind,
    url: string | null,
    declaredCharset: string | null,
    label: string,
  ) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ kind, url, declaredCharset, label });
  };

  add('epub', findUrl(entries, ['application/epub+zip']), null, 'EPUB');
  add(
    'text-utf8',
    findUrl(entries, ['text/plain; charset=utf-8', 'text/plain;charset=utf-8']),
    'utf-8',
    'Plain text (UTF-8)',
  );
  add(
    'text-ascii',
    findUrl(entries, ['text/plain; charset=us-ascii', 'text/plain;charset=us-ascii']),
    'us-ascii',
    'Plain text (US-ASCII)',
  );
  add('text-utf8', findUrl(entries, ['text/plain']), null, 'Plain text');
  add(
    'html',
    findUrl(entries, ['text/html; charset=utf-8', 'text/html;charset=utf-8']),
    'utf-8',
    'HTML (UTF-8)',
  );
  add(
    'html',
    findUrl(entries, ['text/html', 'text/html; charset=us-ascii', 'text/html;charset=us-ascii']),
    null,
    'HTML',
  );

  return sources;
}

export function synthesiseGutenbergSources(id: string): GutenbergSource[] {
  if (!id) return [];
  return [
    {
      kind: 'epub',
      url: `https://www.gutenberg.org/ebooks/${id}.epub3.images`,
      declaredCharset: null,
      label: 'EPUB (synthesised)',
    },
    {
      kind: 'text-utf8',
      url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
      declaredCharset: null,
      label: 'Plain text (synthesised)',
    },
    {
      kind: 'html',
      url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`,
      declaredCharset: null,
      label: 'HTML (synthesised)',
    },
  ];
}

function dedupe(sources: GutenbergSource[]): GutenbergSource[] {
  const seen = new Set<string>();
  const out: GutenbergSource[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
  }
  return out;
}

export async function resolveGutenbergSources(book: {
  sourceId: string | null;
  epubUrl: string | null;
}): Promise<{ sources: GutenbergSource[]; resolvedFrom: 'row' | 'gutendex' | 'synthesised' }> {
  const sources: GutenbergSource[] = [];
  let rowAdded = false;

  if (book.epubUrl) {
    sources.push({
      kind: 'epub',
      url: book.epubUrl,
      declaredCharset: null,
      label: 'EPUB',
    });
    rowAdded = true;
  }

  let gutendexAdded = false;
  if (book.sourceId && /^\d+$/.test(book.sourceId.trim())) {
    try {
      const data = await fetchJson<GutendexBook>(
        `https://gutendex.com/books/${book.sourceId.trim()}`,
        { cacheTtlMs: 10 * 60_000 },
      );
      const formatted = sourcesFromFormats(data.formats);
      if (formatted.length) {
        sources.push(...formatted);
        gutendexAdded = true;
      }
    } catch {
      /* offline: the synthesised chain below still applies */
    }
  }

  if (book.sourceId) sources.push(...synthesiseGutenbergSources(book.sourceId));

  return {
    sources: dedupe(sources),
    resolvedFrom: gutendexAdded ? 'gutendex' : rowAdded ? 'row' : 'synthesised',
  };
}
