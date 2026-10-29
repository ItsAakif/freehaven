import { db } from '@/data/db';
import { newId } from '@/lib/id';
import { ftsQuery } from '@/providers/catalogue';
import { logActivity, readingMinutes } from './activity';
import type { Bookmark, Chunk, Document, Highlight, ReadingPosition, Section } from '@/domain/types';

export async function getDocument(bookId: string): Promise<Document | null> {
  const row = await db().first<{
    id: string;
    book_id: string;
    format: string;
    file_path: string | null;
    file_size: number | null;
    page_count: number | null;
    word_count: number | null;
    status: string;
    error: string | null;
    extractor: string | null;
    imported_at: number;
  }>('SELECT * FROM documents WHERE book_id = ? ORDER BY imported_at DESC LIMIT 1', [bookId]);
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    format: row.format as Document['format'],
    filePath: row.file_path,
    fileSize: row.file_size,
    pageCount: row.page_count,
    wordCount: row.word_count,
    status: row.status as Document['status'],
    error: row.error,
    extractor: row.extractor,
    importedAt: row.imported_at,
  };
}

export async function saveDocument(document: Document): Promise<void> {
  await db().run(
    `INSERT INTO documents (id, book_id, format, file_path, file_size, page_count, word_count, status, error, extractor, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET format=excluded.format, file_path=excluded.file_path,
       file_size=excluded.file_size, page_count=excluded.page_count, word_count=excluded.word_count,
       status=excluded.status, error=excluded.error, extractor=excluded.extractor`,
    [
      document.id,
      document.bookId,
      document.format,
      document.filePath ?? null,
      document.fileSize ?? null,
      document.pageCount ?? null,
      document.wordCount ?? null,
      document.status,
      document.error ?? null,
      document.extractor ?? null,
      document.importedAt,
    ],
  );
}

export async function setDocumentStatus(
  documentId: string,
  status: Document['status'],
  error?: string | null,
): Promise<void> {
  await db().run('UPDATE documents SET status = ?, error = ? WHERE id = ?', [
    status,
    error ?? null,
    documentId,
  ]);
}

/** Replace the extracted structure atomically so a failed import never half-applies. */
export async function replaceExtraction(
  documentId: string,
  sections: Section[],
  chunks: Chunk[],
): Promise<void> {
  await db().transaction(async () => {
    await db().run('DELETE FROM chunks WHERE document_id = ?', [documentId]);
    await db().run('DELETE FROM sections WHERE document_id = ?', [documentId]);
    for (const section of sections) {
      await db().run(
        `INSERT INTO sections (id, document_id, ordinal, title, href, start_page, end_page, char_start, char_end, text)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          section.id,
          documentId,
          section.ordinal,
          section.title ?? null,
          section.href ?? null,
          section.startPage ?? null,
          section.endPage ?? null,
          section.charStart ?? null,
          section.charEnd ?? null,
          section.text ?? null,
        ],
      );
    }
    for (const chunk of chunks) {
      await db().run(
        `INSERT INTO chunks (id, document_id, section_id, ordinal, text, page, char_start, char_end)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          chunk.id,
          documentId,
          chunk.sectionId ?? null,
          chunk.ordinal,
          chunk.text,
          chunk.page ?? null,
          chunk.charStart ?? null,
          chunk.charEnd ?? null,
        ],
      );
    }
  });
}

export async function listSections(documentId: string): Promise<Section[]> {
  const rows = await db().all<{
    id: string;
    document_id: string;
    ordinal: number;
    title: string | null;
    href: string | null;
    start_page: number | null;
    end_page: number | null;
    char_start: number | null;
    char_end: number | null;
    text: string | null;
  }>('SELECT * FROM sections WHERE document_id = ? ORDER BY ordinal', [documentId]);
  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    ordinal: r.ordinal,
    title: r.title,
    href: r.href,
    startPage: r.start_page,
    endPage: r.end_page,
    charStart: r.char_start,
    charEnd: r.char_end,
    text: r.text,
  }));
}

export async function listChunks(documentId: string): Promise<Chunk[]> {
  const rows = await db().all<{
    id: string;
    document_id: string;
    section_id: string | null;
    ordinal: number;
    text: string;
    page: number | null;
    char_start: number | null;
    char_end: number | null;
  }>('SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal', [documentId]);
  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    sectionId: r.section_id,
    ordinal: r.ordinal,
    text: r.text,
    page: r.page,
    charStart: r.char_start,
    charEnd: r.char_end,
  }));
}

export async function getChunk(chunkId: string): Promise<Chunk | null> {
  const r = await db().first<{
    id: string;
    document_id: string;
    section_id: string | null;
    ordinal: number;
    text: string;
    page: number | null;
    char_start: number | null;
    char_end: number | null;
  }>('SELECT * FROM chunks WHERE id = ?', [chunkId]);
  if (!r) return null;
  return {
    id: r.id,
    documentId: r.document_id,
    sectionId: r.section_id,
    ordinal: r.ordinal,
    text: r.text,
    page: r.page,
    charStart: r.char_start,
    charEnd: r.char_end,
  };
}

export async function listChunksForBook(bookId: string): Promise<Chunk[]> {
  const rows = await db().all<{ id: string; document_id: string }>(
    'SELECT id FROM documents WHERE book_id = ?',
    [bookId],
  );
  const all: Chunk[] = [];
  for (const row of rows) all.push(...(await listChunks(row.id)));
  return all;
}

export async function searchBookChunks(bookId: string, query: string, limit = 20): Promise<Chunk[]> {
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = await db().all<{
    id: string;
    document_id: string;
    section_id: string | null;
    ordinal: number;
    text: string;
    page: number | null;
    char_start: number | null;
    char_end: number | null;
  }>(
    `SELECT c.* FROM chunks_fts f
     JOIN chunks c ON c.id = f.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE chunks_fts MATCH ? AND d.book_id = ?
     ORDER BY rank LIMIT ?`,
    [match, bookId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    sectionId: r.section_id,
    ordinal: r.ordinal,
    text: r.text,
    page: r.page,
    charStart: r.char_start,
    charEnd: r.char_end,
  }));
}

/* ------------------------------------------------------------ positions */

export async function getReadingPosition(bookId: string): Promise<ReadingPosition | null> {
  const r = await db().first<{
    book_id: string;
    locator: string;
    percent: number;
    section_title: string | null;
    updated_at: number;
  }>('SELECT * FROM reading_positions WHERE book_id = ?', [bookId]);
  if (!r) return null;
  return {
    bookId: r.book_id,
    locator: r.locator,
    percent: r.percent,
    sectionTitle: r.section_title,
    updatedAt: r.updated_at,
  };
}

export async function saveReadingPosition(position: ReadingPosition): Promise<void> {
  const previous = await getReadingPosition(position.bookId);
  const document = await db().first<{ word_count: number | null }>(
    'SELECT word_count FROM documents WHERE book_id = ? ORDER BY imported_at DESC LIMIT 1',
    [position.bookId],
  );
  await db().run(
    `INSERT INTO reading_positions (book_id, locator, percent, section_title, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(book_id) DO UPDATE SET locator=excluded.locator, percent=excluded.percent,
       section_title=excluded.section_title, updated_at=excluded.updated_at`,
    [position.bookId, position.locator, position.percent, position.sectionTitle ?? null, position.updatedAt],
  );

  // Log time only when the reader has genuinely advanced ~1% of the book, so
  // debounced scroll saves do not flood the activity timeline.
  const delta = position.percent - (previous?.percent ?? 0);
  if (delta >= 0.01) {
    const minutes = readingMinutes(document?.word_count ?? null, delta);
    if (minutes > 0) {
      await logActivity('read', {
        bookId: position.bookId,
        minutes,
        metadata: { percent: Number(position.percent.toFixed(3)) },
      });
    }
  }
}

/* ------------------------------------------------------------- bookmarks */

export async function addBookmark(
  bookId: string,
  locator: string,
  label: string,
  options: { folderId?: string | null; tags?: string[] } = {},
): Promise<Bookmark> {
  const bookmark: Bookmark = {
    id: newId('bm'),
    bookId,
    locator,
    label: label.trim() || null,
    folderId: options.folderId ?? null,
    tags: options.tags?.length ? options.tags.map((t) => t.trim()).filter(Boolean) : null,
    createdAt: Date.now(),
  };
  await db().run(
    'INSERT INTO bookmarks (id, book_id, locator, label, folder_id, tags_json, created_at) VALUES (?,?,?,?,?,?,?)',
    [
      bookmark.id,
      bookmark.bookId,
      bookmark.locator,
      bookmark.label,
      bookmark.folderId ?? null,
      bookmark.tags ? JSON.stringify(bookmark.tags) : null,
      bookmark.createdAt,
    ],
  );
  await logActivity('bookmark', { bookId, metadata: { label: bookmark.label, folderId: bookmark.folderId } });
  return bookmark;
}

export async function updateBookmark(
  id: string,
  patch: { label?: string; folderId?: string | null; tags?: string[] },
): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.label !== undefined) {
    fields.push('label = ?');
    params.push(patch.label.trim() || null);
  }
  if (patch.folderId !== undefined) {
    fields.push('folder_id = ?');
    params.push(patch.folderId);
  }
  if (patch.tags !== undefined) {
    fields.push('tags_json = ?');
    params.push(patch.tags.length ? JSON.stringify(patch.tags) : null);
  }
  if (!fields.length) return;
  params.push(id);
  await db().run(`UPDATE bookmarks SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function listBookmarks(bookId: string): Promise<Bookmark[]> {
  const rows = await db().all<{
    id: string;
    book_id: string;
    locator: string;
    label: string | null;
    folder_id: string | null;
    tags_json: string | null;
    created_at: number;
  }>('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY created_at DESC', [bookId]);
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    locator: r.locator,
    label: r.label,
    folderId: r.folder_id,
    tags: r.tags_json ? (JSON.parse(r.tags_json) as string[]) : null,
    createdAt: r.created_at,
  }));
}

export type BookmarkFolder = { id: string; name: string; color: string | null; createdAt: number };

export async function listBookmarkFolders(): Promise<BookmarkFolder[]> {
  const rows = await db().all<{ id: string; name: string; color: string | null; created_at: number }>(
    'SELECT * FROM bookmark_folders ORDER BY created_at ASC',
  );
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at }));
}

export async function createBookmarkFolder(name: string, color?: string): Promise<BookmarkFolder> {
  const folder: BookmarkFolder = {
    id: newId('folder'),
    name: name.trim() || 'Folder',
    color: color ?? null,
    createdAt: Date.now(),
  };
  await db().run('INSERT INTO bookmark_folders (id, name, color, created_at) VALUES (?,?,?,?)', [
    folder.id,
    folder.name,
    folder.color,
    folder.createdAt,
  ]);
  return folder;
}

export async function deleteBookmarkFolder(id: string): Promise<void> {
  await db().transaction(async () => {
    await db().run('UPDATE bookmarks SET folder_id = NULL WHERE folder_id = ?', [id]);
    await db().run('DELETE FROM bookmark_folders WHERE id = ?', [id]);
  });
}

export async function deleteBookmark(id: string): Promise<void> {
  await db().run('DELETE FROM bookmarks WHERE id = ?', [id]);
}

/* ------------------------------------------------------------ highlights */

export async function addHighlight(input: {
  bookId: string;
  locator: string;
  quote: string;
  note?: string;
  color?: string;
}): Promise<Highlight> {
  const highlight: Highlight = {
    id: newId('hl'),
    bookId: input.bookId,
    locator: input.locator,
    quote: input.quote.trim(),
    note: input.note?.trim() || null,
    color: input.color ?? 'gold',
    createdAt: Date.now(),
  };
  await db().run(
    'INSERT INTO highlights (id, book_id, locator, quote, note, color, created_at) VALUES (?,?,?,?,?,?,?)',
    [highlight.id, highlight.bookId, highlight.locator, highlight.quote, highlight.note, highlight.color, highlight.createdAt],
  );
  await logActivity('highlight', { bookId: highlight.bookId, metadata: { quote: highlight.quote.slice(0, 80) } });
  return highlight;
}

export async function listHighlights(bookId?: string): Promise<Highlight[]> {
  const rows = bookId
    ? await db().all<HighlightRow>('SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at DESC', [bookId])
    : await db().all<HighlightRow>('SELECT * FROM highlights ORDER BY created_at DESC');
  return rows.map(mapHighlight);
}

type HighlightRow = {
  id: string;
  book_id: string;
  locator: string;
  quote: string;
  note: string | null;
  color: string;
  created_at: number;
};

function mapHighlight(r: HighlightRow): Highlight {
  return {
    id: r.id,
    bookId: r.book_id,
    locator: r.locator,
    quote: r.quote,
    note: r.note,
    color: r.color,
    createdAt: r.created_at,
  };
}

export async function updateHighlightNote(id: string, note: string): Promise<void> {
  await db().run('UPDATE highlights SET note = ? WHERE id = ?', [note.trim() || null, id]);
}

export async function deleteHighlight(id: string): Promise<void> {
  await db().run('DELETE FROM highlights WHERE id = ?', [id]);
}

export async function listHighlightsWithBooks(): Promise<
  (Highlight & { bookTitle: string })[]
> {
  const rows = await db().all<HighlightRow & { title: string | null }>(
    `SELECT h.*, b.title FROM highlights h LEFT JOIN books b ON b.id = h.book_id
     ORDER BY h.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ ...mapHighlight(r), bookTitle: r.title ?? 'Untitled' }));
}

export async function listBookmarksWithBooks(): Promise<
  (Bookmark & { bookTitle: string; folderName: string | null })[]
> {
  const rows = await db().all<{
    id: string;
    book_id: string;
    locator: string;
    label: string | null;
    folder_id: string | null;
    tags_json: string | null;
    created_at: number;
    title: string | null;
    folder_name: string | null;
  }>(
    `SELECT bm.*, b.title, f.name as folder_name
     FROM bookmarks bm
     LEFT JOIN books b ON b.id = bm.book_id
     LEFT JOIN bookmark_folders f ON f.id = bm.folder_id
     ORDER BY bm.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    locator: r.locator,
    label: r.label,
    folderId: r.folder_id,
    tags: r.tags_json ? (JSON.parse(r.tags_json) as string[]) : null,
    createdAt: r.created_at,
    bookTitle: r.title ?? 'Untitled',
    folderName: r.folder_name,
  }));
}

/** Reading stats used by Today and Mindspace. */
export async function readingStats(): Promise<{ booksStarted: number; highlights: number }> {
  const started = await db().first<{ count: number }>(
    'SELECT COUNT(*) as count FROM reading_positions WHERE percent > 0',
  );
  const highlights = await db().first<{ count: number }>('SELECT COUNT(*) as count FROM highlights');
  return { booksStarted: started?.count ?? 0, highlights: highlights?.count ?? 0 };
}
