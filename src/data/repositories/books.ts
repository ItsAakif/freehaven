import { db } from '@/data/db';
import { newId } from '@/lib/id';
import type { Book, BookAccess, BookSource } from '@/domain/types';
import type { CatalogueBook } from '@/providers/catalogue/types';

type BookRow = {
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  language: string | null;
  isbn13: string | null;
  publisher: string | null;
  published_year: number | null;
  page_count: number | null;
  source: string;
  source_id: string | null;
  license: string | null;
  access: string;
  external_url: string | null;
  epub_url: string | null;
  in_library: number;
  created_at: number;
  updated_at: number;
};

export function mapBook(row: BookRow): Book {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    author: row.author,
    description: row.description,
    coverUrl: row.cover_url,
    language: row.language,
    isbn13: row.isbn13,
    publisher: row.publisher,
    publishedYear: row.published_year,
    pageCount: row.page_count,
    source: row.source as BookSource,
    sourceId: row.source_id,
    license: row.license,
    access: row.access as BookAccess,
    externalUrl: row.external_url,
    epubUrl: row.epub_url,
    inLibrary: row.in_library === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Insert or refresh catalogue metadata without changing library membership. */
export async function upsertCatalogueBook(candidate: CatalogueBook): Promise<Book> {
  const now = Date.now();
  await db().run(
    `INSERT INTO books (id, title, subtitle, author, description, cover_url, language, isbn13, publisher,
                        published_year, page_count, source, source_id, license, access, external_url, epub_url,
                        in_library, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, subtitle=excluded.subtitle, author=excluded.author,
       description=COALESCE(excluded.description, books.description),
       cover_url=COALESCE(excluded.cover_url, books.cover_url),
       language=COALESCE(excluded.language, books.language),
       isbn13=COALESCE(excluded.isbn13, books.isbn13),
       publisher=COALESCE(excluded.publisher, books.publisher),
       published_year=COALESCE(excluded.published_year, books.published_year),
       page_count=COALESCE(excluded.page_count, books.page_count),
       license=COALESCE(excluded.license, books.license),
       access=excluded.access,
       external_url=COALESCE(excluded.external_url, books.external_url),
       epub_url=COALESCE(excluded.epub_url, books.epub_url),
       updated_at=excluded.updated_at`,
    [
      candidate.id,
      candidate.title,
      candidate.subtitle ?? null,
      candidate.author ?? null,
      candidate.description ?? null,
      candidate.coverUrl ?? null,
      candidate.language ?? null,
      candidate.isbn13 ?? null,
      candidate.publisher ?? null,
      candidate.publishedYear ?? null,
      candidate.pageCount ?? null,
      candidate.source,
      candidate.sourceId,
      candidate.license ?? null,
      candidate.access,
      candidate.externalUrl ?? null,
      candidate.epubUrl ?? null,
      now,
      now,
    ],
  );
  const book = await getBook(candidate.id);
  if (!book) throw new Error('Book upsert failed.');
  return book;
}

export async function getBook(id: string): Promise<Book | null> {
  const row = await db().first<BookRow>('SELECT * FROM books WHERE id = ?', [id]);
  return row ? mapBook(row) : null;
}

export async function listLibrary(): Promise<Book[]> {
  const rows = await db().all<BookRow>(
    'SELECT * FROM books WHERE in_library = 1 ORDER BY updated_at DESC',
  );
  return rows.map(mapBook);
}

export async function listRecentBooks(limit = 6): Promise<Book[]> {
  const rows = await db().all<BookRow>(
    `SELECT * FROM books WHERE in_library = 1 ORDER BY updated_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(mapBook);
}

export async function setInLibrary(bookId: string, inLibrary: boolean): Promise<void> {
  await db().run('UPDATE books SET in_library = ?, updated_at = ? WHERE id = ?', [
    inLibrary ? 1 : 0,
    Date.now(),
    bookId,
  ]);
}

export async function removeBook(bookId: string): Promise<void> {
  await db().run('DELETE FROM books WHERE id = ?', [bookId]);
}

export async function searchLocalBooks(query: string, limit = 30): Promise<Book[]> {
  const like = `%${query.trim()}%`;
  const rows = await db().all<BookRow>(
    `SELECT * FROM books
     WHERE (title LIKE ? OR author LIKE ? OR isbn13 LIKE ?)
     ORDER BY in_library DESC, updated_at DESC LIMIT ?`,
    [like, like, like, limit],
  );
  return rows.map(mapBook);
}

export async function listBooksByIds(ids: string[]): Promise<Book[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db().all<BookRow>(`SELECT * FROM books WHERE id IN (${placeholders})`, ids);
  const byId = new Map(rows.map((row) => [row.id, mapBook(row)]));
  return ids.map((id) => byId.get(id)).filter((b): b is Book => !!b);
}

export async function countLibrary(): Promise<number> {
  const row = await db().first<{ count: number }>(
    'SELECT COUNT(*) as count FROM books WHERE in_library = 1',
  );
  return row?.count ?? 0;
}

export async function attachTopics(bookId: string, topics: string[]): Promise<void> {
  for (const name of topics.slice(0, 6)) {
    const clean = name.trim().toLowerCase();
    if (!clean) continue;
    const id = `topic_${clean.replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
    await db().run('INSERT OR IGNORE INTO topics (id, name) VALUES (?, ?)', [id, clean]);
    await db().run('INSERT OR IGNORE INTO book_topics (book_id, topic_id) VALUES (?, ?)', [bookId, id]);
  }
}

export async function createManualBook(input: {
  title: string;
  author?: string;
  description?: string;
  language?: string;
}): Promise<Book> {
  const id = newId('book');
  const now = Date.now();
  await db().run(
    `INSERT INTO books (id, title, author, description, language, source, access, in_library, created_at, updated_at)
     VALUES (?,?,?,?,?,'manual','user_import',1,?,?)`,
    [id, input.title.trim(), input.author?.trim() || null, input.description?.trim() || null, input.language || 'en', now, now],
  );
  const book = await getBook(id);
  if (!book) throw new Error('Could not create book.');
  return book;
}

export async function touchBook(bookId: string): Promise<void> {
  await db().run('UPDATE books SET updated_at = ? WHERE id = ?', [Date.now(), bookId]);
}
