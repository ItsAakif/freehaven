import { Directory, File, Paths } from 'expo-file-system';
import { db } from '@/data/db';
import { newId } from '@/lib/id';
import { chunkText, wordCount } from '@/domain/text';
import { parseEpub } from './epub';
import { parsePdf } from './pdf';
import { importFromUrl } from './url';
import { getBook, setInLibrary } from '@/data/repositories/books';
import { replaceExtraction, saveDocument, setDocumentStatus } from '@/data/repositories/reading';
import { enqueueJob, updateJob } from '@/data/repositories/learning';
import type { Chunk, DocumentFormat, Section } from '@/domain/types';

export type ImportPhase = 'copying' | 'parsing' | 'indexing' | 'done';
export type ImportProgress = (phase: ImportPhase, detail?: string) => void;

export type ImportAsset = {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

export type ImportResult = {
  bookId: string;
  documentId: string;
  title: string;
  words: number;
  sections: number;
  warnings: string[];
};

const MAX_IMPORT_BYTES = 80 * 1024 * 1024;

export function detectFormat(name: string, mime?: string | null): DocumentFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.epub') || mime === 'application/epub+zip') return 'epub';
  if (lower.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || mime?.startsWith('text/')) return 'text';
  return null;
}

/** Pure extraction builder: deterministic and unit-testable without Expo FS. */
export function buildExtraction(
  format: DocumentFormat,
  input:
    | { kind: 'epub'; chapters: { title: string; html: string; text: string; href: string }[] }
    | { kind: 'pdf'; pages: { page: number; text: string }[] }
    | { kind: 'text'; text: string; title: string },
): { sections: Section[]; chunks: Chunk[]; words: number; documentId: string } {
  const documentId = newId('doc');
  const sections: Section[] = [];
  const chunks: Chunk[] = [];
  let cursor = 0;

  const add = (title: string, text: string, opts: { page?: number; href?: string }) => {
    const start = cursor;
    const body = text.trim();
    cursor += body.length + 2;
    const section: Section = {
      id: newId('sec'),
      documentId,
      ordinal: sections.length,
      title,
      href: opts.href ?? null,
      startPage: opts.page ?? null,
      endPage: opts.page ?? null,
      charStart: start,
      charEnd: start + body.length,
      text: body,
    };
    sections.push(section);
    const pieces = chunkText(body, { page: opts.page ?? null });
    for (const piece of pieces) {
      chunks.push({
        id: newId('chk'),
        documentId,
        sectionId: section.id,
        ordinal: chunks.length,
        text: piece.text,
        page: opts.page ?? null,
        charStart: start + piece.charStart,
        charEnd: start + piece.charEnd,
      });
    }
  };

  if (input.kind === 'epub') {
    input.chapters.forEach((chapter) => add(chapter.title, chapter.text, { href: chapter.href }));
  } else if (input.kind === 'pdf') {
    input.pages.forEach((page) => add(`Page ${page.page}`, page.text, { page: page.page }));
  } else {
    add(input.title, input.text, {});
  }

  const words = input.kind === 'epub' ? input.chapters.reduce((s, c) => s + wordCount(c.text), 0) : input.kind === 'pdf' ? input.pages.reduce((s, p) => s + wordCount(p.text), 0) : wordCount(input.text);

  return { sections, chunks, words, documentId };
}

async function ensureLibraryDir(): Promise<Directory> {
  const dir = new Directory(Paths.document, 'library');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

async function fileHash(file: File): Promise<string> {
  try {
    return await file.digest('SHA-256');
  } catch {
    return `${file.size}-${file.name}`;
  }
}

async function copyIntoLibrary(source: File, hash: string, ext: string): Promise<File> {
  const dir = await ensureLibraryDir();
  const target = new File(dir, `${hash.slice(0, 32)}.${ext}`);
  if (!target.exists) {
    await source.copy(target);
  }
  return target;
}

/** Import a picked EPUB/PDF/TXT file into the personal library. */
export async function importDocument(
  asset: ImportAsset,
  options: { bookId?: string; onProgress?: ImportProgress } = {},
): Promise<ImportResult> {
  const name = asset.name ?? asset.uri.split('/').pop() ?? 'document';
  const format = detectFormat(name, asset.mimeType);
  if (!format) throw new Error('Freehaven can import EPUB, PDF and plain text files.');

  const source = new File(asset.uri);
  if (!source.exists) throw new Error('The selected file could not be read.');
  if (source.size > MAX_IMPORT_BYTES) throw new Error('Files larger than 80 MB are not supported.');

  options.onProgress?.('copying');
  const hash = await fileHash(source);
  const bookId = options.bookId ?? `import:${hash.slice(0, 24)}`;
  const savedFile = await copyIntoLibrary(source, hash, format);

  const documentId = newId('doc');
  const jobId = await enqueueJob('import', { bookId, format, name });
  await saveDocument({
    id: documentId,
    bookId,
    format,
    filePath: savedFile.uri,
    fileSize: source.size,
    pageCount: null,
    wordCount: null,
    status: 'extracting',
    error: null,
    extractor: format === 'epub' ? 'jszip+opf' : format === 'pdf' ? 'content-stream' : 'utf8',
    importedAt: Date.now(),
  });

  try {
    options.onProgress?.('parsing');
    const bytes = await savedFile.bytes();
    let title = name.replace(/\.[^.]+$/, '');
    let author: string | null = null;
    let extraction: ReturnType<typeof buildExtraction>;
    let pageCount: number | null = null;
    const warnings: string[] = [];

    if (format === 'epub') {
      const parsed = await parseEpub(bytes);
      title = parsed.title;
      author = parsed.author;
      extraction = buildExtraction('epub', { kind: 'epub', chapters: parsed.chapters });
      warnings.push(...parsed.warnings);
      await upsertImportedBook(bookId, { title, author, language: parsed.language, isbn: parsed.identifier, pages: null });
    } else if (format === 'pdf') {
      const parsed = await parsePdf(bytes);
      title = parsed.title ?? title;
      author = parsed.author;
      pageCount = parsed.pageCount;
      extraction = buildExtraction('pdf', { kind: 'pdf', pages: parsed.pages });
      warnings.push(...parsed.warnings);
      await upsertImportedBook(bookId, { title, author, language: null, isbn: null, pages: pageCount });
    } else {
      const text = new TextDecoder().decode(bytes);
      extraction = buildExtraction('text', { kind: 'text', text, title });
      await upsertImportedBook(bookId, { title, author: null, language: null, isbn: null, pages: null });
    }

    options.onProgress?.('indexing', `${extraction.chunks.length} passages`);
    await replaceExtraction(extraction.documentId, extraction.sections, extraction.chunks);
    await db().run(
      'UPDATE documents SET page_count = ?, word_count = ?, status = ?, extractor = ? WHERE id = ?',
      [pageCount, extraction.words, 'ready', format === 'epub' ? 'jszip+opf' : format === 'pdf' ? 'content-stream' : 'utf8', documentId],
    );
    await setInLibrary(bookId, true);
    await updateJob(jobId, 'done');
    options.onProgress?.('done');
    return {
      bookId,
      documentId: extraction.documentId,
      title,
      words: extraction.words,
      sections: extraction.sections.length,
      warnings,
    };
  } catch (error) {
    const message = (error as Error).message;
    await setDocumentStatus(documentId, 'failed', message);
    await updateJob(jobId, 'failed', message);
    throw new Error(message);
  }
}

async function upsertImportedBook(
  bookId: string,
  info: { title: string; author: string | null; language: string | null; isbn: string | null; pages: number | null },
): Promise<void> {
  const existing = await getBook(bookId);
  const now = Date.now();
  if (existing) {
    await db().run(
      `UPDATE books SET title = COALESCE(NULLIF(title,''), ?), author = COALESCE(author, ?),
        page_count = COALESCE(page_count, ?), in_library = 1, updated_at = ? WHERE id = ?`,
      [info.title, info.author, info.pages, now, bookId],
    );
    return;
  }
  await db().run(
    `INSERT INTO books (id, title, author, description, language, isbn13, page_count, source, source_id, license, access, in_library, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'import', ?, 'User-provided copy', 'user_import', 1, ?, ?)`,
    [
      bookId,
      info.title,
      info.author,
      null,
      info.language ?? 'en',
      info.isbn,
      info.pages,
      info.isbn,
      now,
      now,
    ],
  );
}

/** Create a text document from a pasted note or extracted article. */
export async function importTextDocument(title: string, text: string): Promise<ImportResult> {
  if (!text.trim()) throw new Error('The document is empty.');
  if (text.length > 5_000_000) throw new Error('That text is too long to import.');
  const bookId = `text:${newId('src')}`;
  await upsertImportedBook(bookId, { title: title.trim() || 'Untitled note', author: null, language: null, isbn: null, pages: null });
  const extraction = buildExtraction('text', { kind: 'text', text, title });
  await saveDocument({
    id: extraction.documentId,
    bookId,
    format: 'text',
    filePath: null,
    fileSize: text.length,
    pageCount: null,
    wordCount: extraction.words,
    status: 'ready',
    error: null,
    extractor: 'utf8',
    importedAt: Date.now(),
  });
  await replaceExtraction(extraction.documentId, extraction.sections, extraction.chunks);
  return {
    bookId,
    documentId: extraction.documentId,
    title,
    words: extraction.words,
    sections: extraction.sections.length,
    warnings: [],
  };
}

/** Import a web article with SSRF checks (see url.ts). */
export async function importArticle(url: string): Promise<ImportResult> {
  const article = await importFromUrl(url);
  const result = await importTextDocument(article.title, article.text);
  await db().run('UPDATE books SET source = ?, external_url = ?, updated_at = ? WHERE id = ?', [
    'import',
    article.url,
    Date.now(),
    result.bookId,
  ]);
  return result;
}

/** Download a public-domain EPUB and attach it to an existing catalogue book. */
export async function downloadGutenbergBook(bookId: string, epubUrl: string): Promise<ImportResult> {
  const dir = new Directory(Paths.cache, 'downloads');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = await File.downloadFileAsync(epubUrl, dir);
  return importDocument(
    { uri: file.uri, name: `${bookId.replace(/[^a-z0-9]+/gi, '-')}.epub`, mimeType: 'application/epub+zip' },
    { bookId },
  );
}
