import { Directory, File, Paths } from 'expo-file-system';
import { db } from '@/data/db';
import { newId } from '@/lib/id';
import { chunkText, normalizeWhitespace, wordCount } from '@/domain/text';
import { decodeBytes } from './charset';
import { EpubError, parseEpub } from './epub';
import { stripBoilerplateFromRawHtml, stripGutenbergBoilerplate } from './gutenberg';
import type { BoilerplateResult, BoilerplateWarning } from './gutenberg';
import { htmlTitle, htmlToText } from './html';
import { parsePdf } from './pdf';
import { assessTextQuality } from './quality';
import type { ImportQuality, NarrationEligibility, TextScript } from './quality';
import {
  MAX_EPUB_BYTES,
  MAX_HTML_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  sniffBytes,
} from './sniff';
import type { SniffedFormat } from './sniff';
import { importFromUrl } from './url';
import { resolveGutenbergSources } from './gutenbergSources';
import type { GutenbergSource } from './gutenbergSources';
import { getBook, setInLibrary } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
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
  sourceFormat: SniffedFormat;
  charset: string;
  quality: ImportQuality;
  qualityReasons: string[];
  boilerplate: BoilerplateResult;
  narrationEligible: NarrationEligibility;
};

export class ImportFailure extends Error {
  constructor(
    message: string,
    readonly quality?: ImportQuality,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'ImportFailure';
  }
}

const MAX_IMPORT_BYTES = 80 * 1024 * 1024;

export function detectFormat(name: string, mime?: string | null): DocumentFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.epub') || mime === 'application/epub+zip') return 'epub';
  if (lower.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    mime?.startsWith('text/')
  ) {
    return 'text';
  }
  return null;
}

/** Pure extraction builder: deterministic and unit-testable without Expo FS. */
export function buildExtraction(
  format: DocumentFormat,
  input:
    | { kind: 'epub'; chapters: { title: string; html: string; text: string; href: string }[] }
    | { kind: 'pdf'; pages: { page: number; text: string }[] }
    | { kind: 'text'; text: string; title: string },
  documentId: string = newId('doc'),
): { sections: Section[]; chunks: Chunk[]; words: number; documentId: string } {
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

export type ExtractedImport = {
  format: DocumentFormat;
  sourceFormat: SniffedFormat;
  charset: string;
  script: TextScript;
  title: string;
  author: string | null;
  language: string | null;
  identifier: string | null;
  pageCount: number | null;
  extraction: ReturnType<typeof buildExtraction>;
  quality: ImportQuality;
  qualityReasons: string[];
  boilerplate: BoilerplateResult;
  narration: NarrationEligibility;
  warnings: string[];
};

function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'Untitled';
}

function emptyBoilerplate(text = ''): BoilerplateResult {
  return {
    text,
    start: { found: false, index: null },
    end: { found: false, index: null },
    producedBy: { found: false, removedChars: 0 },
    removedChars: 0,
    warnings: ['no_licence_markers'],
    suspiciousCut: false,
  };
}

function combineBoilerplate(results: BoilerplateResult[], text: string): BoilerplateResult {
  if (!results.length) return emptyBoilerplate(text);
  const warnings = new Set<BoilerplateWarning>();
  let removed = 0;
  let producedFound = false;
  let producedRemoved = 0;
  let suspiciousCut = false;
  let startFound = false;
  let endFound = false;
  for (const result of results) {
    result.warnings.forEach((warning) => warnings.add(warning));
    removed += result.removedChars;
    producedFound = producedFound || result.producedBy.found;
    producedRemoved += result.producedBy.removedChars;
    suspiciousCut = suspiciousCut || result.suspiciousCut;
    startFound = startFound || result.start.found;
    endFound = endFound || result.end.found;
  }
  return {
    text,
    start: { found: startFound, index: null },
    end: { found: endFound, index: null },
    producedBy: { found: producedFound, removedChars: producedRemoved },
    removedChars: removed,
    warnings: [...warnings],
    suspiciousCut,
  };
}

function failedResult(input: {
  format: DocumentFormat;
  sourceFormat: SniffedFormat;
  charset: string;
  title: string;
  author?: string | null;
  language?: string | null;
  identifier?: string | null;
  pageCount?: number | null;
  quality: ImportQuality;
  reasons: string[];
  boilerplate: BoilerplateResult;
  narration: NarrationEligibility;
  warnings: string[];
  documentId?: string;
}): ExtractedImport {
  return {
    format: input.format,
    sourceFormat: input.sourceFormat,
    charset: input.charset,
    script: 'unknown',
    title: input.title,
    author: input.author ?? null,
    language: input.language ?? null,
    identifier: input.identifier ?? null,
    pageCount: input.pageCount ?? null,
    extraction: buildExtraction(
      input.format,
      { kind: 'text', text: '', title: input.title },
      input.documentId,
    ),
    quality: input.quality,
    qualityReasons: input.reasons,
    boilerplate: input.boilerplate,
    narration: input.narration,
    warnings: input.warnings,
  };
}

/**
 * Sniff bytes, pick a parser and assess the text. Pure apart from `parseEpub`
 * and `parsePdf`, so the whole dispatch is unit-testable in Node.
 */
export async function extractDocument(
  bytes: Uint8Array,
  input: { name: string; mimeType?: string | null; documentId?: string },
): Promise<ExtractedImport> {
  const name = input.name;
  const documentId = input.documentId;
  const declared = detectFormat(name, input.mimeType) ?? 'text';
  const sniff = sniffBytes(bytes, { name, mime: input.mimeType });

  if (sniff.format === 'epub') {
    let parsed: Awaited<ReturnType<typeof parseEpub>>;
    try {
      parsed = await parseEpub(bytes);
    } catch (error) {
      const code = error instanceof EpubError ? error.code : null;
      if (code === 'no_readable_chapters' || code === 'too_large' || code === 'drm_protected') {
        return failedResult({
          format: 'epub',
          sourceFormat: 'epub',
          charset: 'utf-8',
          title: titleFromName(name),
          quality: 'unsupported_media',
          reasons: [code],
          boilerplate: emptyBoilerplate(),
          narration: { allowed: false, maxLength: null, reason: 'unsupported_media' },
          warnings: [code],
          documentId,
        });
      }
      throw error;
    }

    const kept: typeof parsed.chapters = [];
    const boilerplates: BoilerplateResult[] = [];
    for (const chapter of parsed.chapters) {
      const stripped = stripGutenbergBoilerplate(chapter.text);
      boilerplates.push(stripped);
      const words = wordCount(stripped.text);
      if (words < 5) continue;
      kept.push({ ...chapter, text: stripped.text, wordCount: words });
    }

    if (!kept.length) {
      return failedResult({
        format: 'epub',
        sourceFormat: 'epub',
        charset: 'utf-8',
        title: parsed.title,
        author: parsed.author,
        language: parsed.language,
        identifier: parsed.identifier,
        quality: 'unsupported_media',
        reasons: ['no_readable_chapters'],
        boilerplate: combineBoilerplate(boilerplates, ''),
        narration: { allowed: false, maxLength: null, reason: 'unsupported_media' },
        warnings: parsed.warnings,
        documentId,
      });
    }

    const text = normalizeWhitespace(kept.map((chapter) => chapter.text).join('\n\n'));
    const boilerplate = combineBoilerplate(boilerplates, text);
    const markersFound = boilerplate.start.found || boilerplate.end.found;
    const assessment = assessTextQuality({ text, source: 'epub', markersFound });
    const extraction = buildExtraction('epub', { kind: 'epub', chapters: kept }, documentId);

    return {
      format: 'epub',
      sourceFormat: 'epub',
      charset: 'utf-8',
      script: assessment.metrics.script,
      title: parsed.title,
      author: parsed.author,
      language: parsed.language,
      identifier: parsed.identifier,
      pageCount: null,
      extraction,
      quality: assessment.verdict,
      qualityReasons: assessment.reasons,
      boilerplate,
      narration: assessment.narration,
      warnings: parsed.warnings,
    };
  }

  if (sniff.format === 'pdf') {
    let parsed: Awaited<ReturnType<typeof parsePdf>>;
    try {
      parsed = await parsePdf(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no text layer|text layer|scanned/i.test(message)) {
        return failedResult({
          format: 'pdf',
          sourceFormat: 'pdf',
          charset: 'binary',
          title: titleFromName(name),
          pageCount: 1,
          quality: 'needs_ocr',
          reasons: ['needs_ocr'],
          boilerplate: emptyBoilerplate(),
          narration: { allowed: false, maxLength: null, reason: 'needs_ocr' },
          warnings: [message],
          documentId,
        });
      }
      throw error;
    }

    const text = normalizeWhitespace(parsed.pages.map((page) => page.text).join('\n\n'));
    const assessment = assessTextQuality({
      text,
      source: 'pdf',
      pageCount: parsed.pageCount,
      markersFound: false,
    });
    if (assessment.verdict === 'needs_ocr' || assessment.verdict === 'unsupported_media') {
      return failedResult({
        format: 'pdf',
        sourceFormat: 'pdf',
        charset: 'binary',
        title: parsed.title ?? titleFromName(name),
        author: parsed.author,
        pageCount: parsed.pageCount,
        quality: assessment.verdict,
        reasons: assessment.reasons,
        boilerplate: emptyBoilerplate(),
        narration: assessment.narration,
        warnings: parsed.warnings,
        documentId,
      });
    }
    return {
      format: 'pdf',
      sourceFormat: 'pdf',
      charset: 'binary',
      script: assessment.metrics.script,
      title: parsed.title ?? titleFromName(name),
      author: parsed.author,
      language: null,
      identifier: null,
      pageCount: parsed.pageCount,
      extraction: buildExtraction('pdf', { kind: 'pdf', pages: parsed.pages }, documentId),
      quality: assessment.verdict,
      qualityReasons: assessment.reasons,
      boilerplate: emptyBoilerplate(),
      narration: assessment.narration,
      warnings: parsed.warnings,
    };
  }

  if (sniff.format === 'html' || sniff.format === 'text') {
    const decoded = decodeBytes(bytes, { charset: sniff.charset });
    const isHtml = sniff.format === 'html';
    let boilerplate: BoilerplateResult;
    let text: string;
    let title = titleFromName(name);
    if (isHtml) {
      const cut = stripBoilerplateFromRawHtml(decoded.text);
      boilerplate = cut.result;
      text = htmlToText(cut.cut);
      title = htmlTitle(decoded.text) ?? title;
    } else {
      boilerplate = stripGutenbergBoilerplate(decoded.text);
      text = boilerplate.text;
    }

    const normalized = normalizeWhitespace(text);
    const markersFound = boilerplate.start.found || boilerplate.end.found;
    const assessment = assessTextQuality({
      text: normalized,
      source: isHtml ? 'html' : 'text',
      markersFound,
      sniffedFormat: sniff.format,
    });

    if (assessment.verdict === 'unsupported_media') {
      return failedResult({
        format: 'text',
        sourceFormat: sniff.format,
        charset: decoded.charset,
        title,
        quality: assessment.verdict,
        reasons: assessment.reasons,
        boilerplate,
        narration: assessment.narration,
        warnings: boilerplate.warnings,
        documentId,
      });
    }

    return {
      format: 'text',
      sourceFormat: sniff.format,
      charset: decoded.charset,
      script: assessment.metrics.script,
      title,
      author: null,
      language: null,
      identifier: null,
      pageCount: null,
      extraction: buildExtraction('text', { kind: 'text', text: normalized, title }, documentId),
      quality: assessment.verdict,
      qualityReasons: assessment.reasons,
      boilerplate,
      narration: assessment.narration,
      warnings: boilerplate.warnings,
    };
  }

  // image / audio / gzip / zip / unknown: no readable text at all.
  const assessment = assessTextQuality({
    text: '',
    source: 'text',
    markersFound: false,
    sniffedFormat: sniff.format,
  });
  return failedResult({
    format: declared,
    sourceFormat: sniff.format,
    charset: 'unknown',
    title: titleFromName(name),
    quality: 'unsupported_media',
    reasons: [sniff.reason ?? 'unsupported_media'],
    boilerplate: emptyBoilerplate(),
    narration: assessment.narration,
    warnings: [],
    documentId,
  });
}

function extractorTag(result: ExtractedImport, origin: 'local' | 'gutenberg'): string {
  const base = `${result.format}:${result.charset}`;
  return origin === 'gutenberg' ? `gutenberg:${base}:${result.script}` : base;
}

function failureMessage(quality: ImportQuality, title: string): string {
  if (quality === 'needs_ocr') {
    return 'This PDF is a scan with no text layer. OCR is not available in this build; you can still open the original in your device viewer.';
  }
  if (quality === 'unsupported_media') {
    return `This edition of “${title}” has no readable text (audio/image only). Try another edition.`;
  }
  return 'This text could not be imported.';
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

/** Import already-read bytes; persistence and job bookkeeping only. */
export async function importBytes(input: {
  bookId: string;
  name: string;
  mimeType?: string | null;
  bytes: Uint8Array;
  origin: 'local' | 'gutenberg';
  filePath: string | null;
  fileSize: number;
  onProgress?: ImportProgress;
}): Promise<ImportResult> {
  const declared = detectFormat(input.name, input.mimeType) ?? 'text';
  const documentId = newId('doc');
  const jobId = await enqueueJob('import', {
    bookId: input.bookId,
    format: declared,
    name: input.name,
  });

  input.onProgress?.('parsing');
  let result: ExtractedImport;
  try {
    result = await extractDocument(input.bytes, {
      name: input.name,
      mimeType: input.mimeType,
      documentId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertImportedBook(input.bookId, {
      title: titleFromName(input.name),
      author: null,
      language: null,
      isbn: null,
      pages: null,
    });
    await saveDocument({
      id: documentId,
      bookId: input.bookId,
      format: declared,
      filePath: input.filePath,
      fileSize: input.fileSize,
      pageCount: null,
      wordCount: null,
      status: 'failed',
      error: message,
      extractor: `${declared}:unknown`,
      importedAt: Date.now(),
    });
    await updateJob(jobId, 'failed', message);
    throw error;
  }

  await upsertImportedBook(input.bookId, {
    title: result.title,
    author: result.author,
    language: result.language,
    isbn: result.identifier,
    pages: result.pageCount,
  });

  const isFailed = result.quality === 'needs_ocr' || result.quality === 'unsupported_media';
  const extractor = extractorTag(result, input.origin);

  if (isFailed) {
    await saveDocument({
      id: documentId,
      bookId: input.bookId,
      format: result.format,
      filePath: input.filePath,
      fileSize: input.fileSize,
      pageCount: result.pageCount,
      wordCount: 0,
      status: 'failed',
      error: result.quality,
      extractor,
      importedAt: Date.now(),
    });
    const message = failureMessage(result.quality, result.title);
    await updateJob(jobId, 'failed', message);
    throw new ImportFailure(message, result.quality, result.qualityReasons);
  }

  input.onProgress?.('indexing', `${result.extraction.chunks.length} passages`);
  await saveDocument({
    id: documentId,
    bookId: input.bookId,
    format: result.format,
    filePath: input.filePath,
    fileSize: input.fileSize,
    pageCount: result.pageCount,
    wordCount: result.extraction.words,
    status: 'ready',
    error: result.quality === 'ready' ? null : result.quality,
    extractor,
    importedAt: Date.now(),
  });
  await replaceExtraction(result.extraction.documentId, result.extraction.sections, result.extraction.chunks);
  await setInLibrary(input.bookId, true);
  await updateJob(jobId, 'done');
  input.onProgress?.('done');

  return {
    bookId: input.bookId,
    documentId: result.extraction.documentId,
    title: result.title,
    words: result.extraction.words,
    sections: result.extraction.sections.length,
    warnings: result.warnings,
    sourceFormat: result.sourceFormat,
    charset: result.charset,
    quality: result.quality,
    qualityReasons: result.qualityReasons,
    boilerplate: result.boilerplate,
    narrationEligible: result.narration,
  };
}

/** Import a picked EPUB/PDF/TXT/HTML file into the personal library. */
export async function importDocument(
  asset: ImportAsset,
  options: { bookId?: string; onProgress?: ImportProgress; origin?: 'local' | 'gutenberg' } = {},
): Promise<ImportResult> {
  const name = asset.name ?? asset.uri.split('/').pop() ?? 'document';
  const format = detectFormat(name, asset.mimeType);
  if (!format) throw new Error('Freehaven can import EPUB, PDF, plain text and HTML files.');

  const source = new File(asset.uri);
  if (!source.exists) throw new Error('The selected file could not be read.');
  if (source.size > MAX_IMPORT_BYTES) throw new Error('Files larger than 80 MB are not supported.');

  options.onProgress?.('copying');
  const hash = await fileHash(source);
  const bookId = options.bookId ?? `import:${hash.slice(0, 24)}`;
  const savedFile = await copyIntoLibrary(source, hash, format);
  const bytes = await savedFile.bytes();

  return importBytes({
    bookId,
    name,
    mimeType: asset.mimeType,
    bytes,
    origin: options.origin ?? 'local',
    filePath: savedFile.uri,
    fileSize: source.size,
    onProgress: options.onProgress,
  });
}

async function upsertImportedBook(
  bookId: string,
  info: { title: string; author: string | null; language: string | null; isbn: string | null; pages: number | null },
): Promise<void> {
  const existing = await getBook(bookId);
  const now = Date.now();
  if (existing) {
    await db().run(
      `UPDATE books SET title = COALESCE(NULLIF(?, ''), title), author = COALESCE(?, author),
        language = COALESCE(?, language), page_count = COALESCE(?, page_count),
        in_library = 1, updated_at = ? WHERE id = ?`,
      [info.title, info.author, info.language, info.pages, now, bookId],
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
  const normalized = normalizeWhitespace(text);
  const assessment = assessTextQuality({ text: normalized, source: 'text', markersFound: false });
  const boilerplate = emptyBoilerplate(normalized);
  await upsertImportedBook(bookId, { title: title.trim() || 'Untitled note', author: null, language: null, isbn: null, pages: null });
  const documentId = newId('doc');
  const extraction = buildExtraction('text', { kind: 'text', text: normalized, title }, documentId);
  await saveDocument({
    id: documentId,
    bookId,
    format: 'text',
    filePath: null,
    fileSize: text.length,
    pageCount: null,
    wordCount: extraction.words,
    status: 'ready',
    error: assessment.verdict === 'ready' ? null : assessment.verdict,
    extractor: 'text:utf-8',
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
    sourceFormat: 'text',
    charset: 'utf-8',
    quality: assessment.verdict,
    qualityReasons: assessment.reasons,
    boilerplate,
    narrationEligible: assessment.narration,
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

function extensionFor(format: SniffedFormat): string {
  if (format === 'epub') return 'epub';
  if (format === 'pdf') return 'pdf';
  if (format === 'html') return 'html';
  if (format === 'text') return 'txt';
  return 'bin';
}

function mimeFor(format: SniffedFormat): string {
  if (format === 'epub') return 'application/epub+zip';
  if (format === 'pdf') return 'application/pdf';
  if (format === 'html') return 'text/html';
  return 'text/plain';
}

function capFor(format: SniffedFormat): number {
  if (format === 'epub') return MAX_EPUB_BYTES;
  if (format === 'pdf') return MAX_PDF_BYTES;
  if (format === 'html') return MAX_HTML_BYTES;
  return MAX_TEXT_BYTES;
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'book';
}

function statusFromError(message: string): number | null {
  const match = message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Download a readable copy for a catalogue row.
 *
 * Sources are resolved from the row + Gutendex when omitted, then tried in
 * order. Bytes are sniffed before dispatch, so a `.txt` URL returning HTML is
 * parsed as HTML rather than as broken plain text.
 */
export async function downloadGutenbergBook(
  bookId: string,
  input: { sources?: GutenbergSource[] } = {},
): Promise<ImportResult> {
  const book = await getBook(bookId);
  let sources = input.sources;
  if (!sources || !sources.length) {
    const resolved = await resolveGutenbergSources({
      sourceId: book?.sourceId ?? null,
      epubUrl: book?.epubUrl ?? null,
    });
    sources = resolved.sources;
  }
  if (!sources.length) {
    throw new ImportFailure(
      'No download source is available for this title. Open the official source instead.',
      'unsupported_media',
      ['no_sources'],
    );
  }

  const dir = new Directory(Paths.cache, 'downloads');
  if (!dir.exists) dir.create({ intermediates: true });

  const failures: string[] = [];
  let lastQuality: ImportQuality | undefined;

  for (const source of sources) {
    try {
      const file = await File.downloadFileAsync(source.url, dir);
      const bytes = await file.bytes();
      const sniff = sniffBytes(bytes, {
        name: `${slug(bookId)}.${extensionFor(source.kind === 'epub' ? 'epub' : source.kind === 'html' ? 'html' : 'text')}`,
        mime: source.kind === 'epub' ? 'application/epub+zip' : source.kind === 'html' ? 'text/html' : 'text/plain',
      });
      if (bytes.length > capFor(sniff.format)) {
        failures.push(`${source.kind}:too_large`);
        continue;
      }
      if (sniff.format === 'image' || sniff.format === 'audio' || sniff.format === 'gzip') {
        lastQuality = 'unsupported_media';
        failures.push(`${source.kind}:${sniff.format}`);
        continue;
      }
      if (sniff.format === 'zip') {
        failures.push(`${source.kind}:zip_not_epub`);
        continue;
      }
      if (sniff.format === 'unknown') {
        failures.push(`${source.kind}:unknown`);
        continue;
      }
      const extension = extensionFor(sniff.format);
      return await importDocument(
        {
          uri: file.uri,
          name: `${slug(bookId)}.${extension}`,
          mimeType: mimeFor(sniff.format),
        },
        { bookId, origin: 'gutenberg' },
      );
    } catch (error) {
      if (error instanceof ImportFailure) {
        lastQuality = error.quality ?? lastQuality;
        failures.push(`${source.kind}: ${error.message}`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      const status = statusFromError(message);
      failures.push(`${source.kind}: ${status ? `http_${status}` : message}`);
    }
  }

  const detail = failures[failures.length - 1];
  throw new ImportFailure(
    `Could not download a readable copy of this title${detail ? ` (${detail})` : ''}. Try the official source.`,
    lastQuality,
    failures,
  );
}
