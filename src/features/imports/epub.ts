/**
 * EPUB extraction.
 *
 * Parses the container → OPF → spine, pulls readable XHTML per chapter, and
 * produces sanitised chapter HTML plus plain text for search, summaries and
 * citations. No WebView or native module is involved, so this is fully testable.
 *
 * Every failure that has a user-facing outcome is an `EpubError` with a stable
 * `code`; the import service maps codes to quality verdicts without string
 * matching.
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { wordCount } from '../../domain/text';
import { decodeEntities, htmlToText } from './html';

export type EpubErrorCode =
  | 'missing_container'
  | 'missing_opf'
  | 'malformed_opf'
  | 'drm_protected'
  | 'no_readable_chapters'
  | 'too_large';

const EPUB_ERROR_MESSAGES: Record<EpubErrorCode, string> = {
  missing_container: 'This file is not a valid EPUB (missing META-INF/container.xml).',
  missing_opf: 'EPUB package document could not be located.',
  malformed_opf: 'EPUB package document is malformed.',
  drm_protected: 'This EPUB is DRM-protected and cannot be opened.',
  no_readable_chapters: 'No readable chapters were found in this EPUB.',
  too_large: 'This EPUB is too large to open safely on this device.',
};

export class EpubError extends Error {
  constructor(
    readonly code: EpubErrorCode,
    message?: string,
  ) {
    super(message ?? EPUB_ERROR_MESSAGES[code]);
    this.name = 'EpubError';
  }
}

export type EpubChapter = {
  ordinal: number;
  title: string;
  href: string;
  html: string;
  text: string;
  wordCount: number;
};

export type EpubBook = {
  title: string;
  author: string | null;
  language: string | null;
  identifier: string | null;
  publisher: string | null;
  chapters: EpubChapter[];
  totalWords: number;
  warnings: string[];
};

const CHAPTER_CAP_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 120 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text']);
  }
  return '';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export { decodeEntities, htmlToText };

/** Remove scripts, styles, iframes, event handlers and javascript: URLs. */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
}

function extractBody(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

function chapterTitle(html: string, fallback: string): string {
  const heading = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (heading) {
    const text = htmlToText(heading[1]).trim();
    if (text.length > 1 && text.length < 120) return text;
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const text = htmlToText(title[1]).trim();
    if (text) return text;
  }
  return fallback;
}

/**
 * Resolve a relative href against the OPF directory without ever escaping the
 * zip root. A leading `/` is treated as zip-root-relative.
 */
export function resolveHref(baseDir: string, href: string): string {
  const raw = href.split('#')[0].replace(/\\/g, '/');
  const decoded = safeDecode(raw);
  const rootRelative = decoded.startsWith('/');
  const base = rootRelative ? '' : baseDir;
  const parts = `${base}/${decoded}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function truncateChapter(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= CHAPTER_CAP_BYTES) return { text: raw, truncated: false };
  const slice = raw.slice(0, CHAPTER_CAP_BYTES);
  const at = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
    slice.lastIndexOf('\n'),
  );
  return {
    text: at > CHAPTER_CAP_BYTES * 0.5 ? slice.slice(0, at + 1) : slice,
    truncated: true,
  };
}

type NavPoint = { href: string; label: string };

function collectNcxPoints(node: unknown, out: NavPoint[]): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  for (const point of asArray(record.navPoint)) {
    const pointRecord = point as Record<string, unknown>;
    const navLabel = pointRecord.navLabel as Record<string, unknown> | undefined;
    const label = textOf(navLabel?.text ?? navLabel);
    const content = pointRecord.content as Record<string, unknown> | undefined;
    const src = content?.['@_src'];
    if (typeof src === 'string' && src && label) out.push({ href: src, label });
    collectNcxPoints(pointRecord, out);
  }
}

function parseAnchors(html: string): NavPoint[] {
  const out: NavPoint[] = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html))) {
    const href = match[1].split('#')[0];
    const label = htmlToText(match[2]).trim();
    if (href && label) out.push({ href, label });
  }
  return out;
}

function declaredSize(zip: JSZip): { total: number | null; known: boolean } {
  let total = 0;
  let unknown = false;
  for (const name of Object.keys(zip.files)) {
    const data = (zip.files[name] as unknown as { _data?: { uncompressedSize?: unknown } })._data;
    const size = data?.uncompressedSize;
    if (typeof size === 'number') total += size;
    else unknown = true;
  }
  return { total: unknown ? null : total, known: !unknown };
}

async function assertNoDrm(zip: JSZip): Promise<void> {
  const encryption = zip.file('META-INF/encryption.xml');
  if (!encryption) return;
  const xml = await encryption.async('string');
  const re = /<(?:[\w.-]+:)?CipherReference\b[^>]*\bURI\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const uri = safeDecode(match[1].split('#')[0]);
    if (!/\.(ttf|otf|woff2?)$/i.test(uri)) throw new EpubError('drm_protected');
  }
}

type OpfItem = {
  '@_id'?: string;
  '@_href'?: string;
  '@_media-type'?: string;
  '@_properties'?: string;
};

export async function parseEpub(bytes: Uint8Array | ArrayBuffer): Promise<EpubBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new EpubError('missing_container');
  }
  const warnings: string[] = [];

  if (Object.keys(zip.files).length > MAX_ENTRIES) throw new EpubError('too_large');
  const sizes = declaredSize(zip);
  if (sizes.total === null) warnings.push('size_cap_unavailable');
  else if (sizes.total > MAX_UNCOMPRESSED_BYTES) throw new EpubError('too_large');

  await assertNoDrm(zip);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new EpubError('missing_container');

  let containerXml: {
    container?: { rootfiles?: { rootfile?: { '@_full-path'?: string } | { '@_full-path'?: string }[] } };
  };
  try {
    containerXml = parser.parse(await containerFile.async('string')) as typeof containerXml;
  } catch {
    throw new EpubError('missing_opf');
  }
  const rootfile = asArray(containerXml.container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.['@_full-path'];
  if (!opfPath) throw new EpubError('missing_opf');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new EpubError('missing_opf');

  let opf: {
    package?: {
      metadata?: Record<string, unknown>;
      manifest?: { item?: OpfItem | OpfItem[] };
      spine?: {
        '@_toc'?: string;
        itemref?: { '@_idref'?: string } | { '@_idref'?: string }[];
      };
    };
  };
  try {
    opf = parser.parse(await opfFile.async('string')) as typeof opf;
  } catch {
    throw new EpubError('malformed_opf');
  }
  const pkg = opf.package;
  if (!pkg?.manifest || !pkg.spine) throw new EpubError('malformed_opf');

  const meta = pkg.metadata ?? {};
  const title = textOf(meta['dc:title'] ?? meta.title) || 'Untitled EPUB';
  const author = textOf(meta['dc:creator'] ?? meta.creator) || null;
  const language = textOf(meta['dc:language'] ?? meta.language) || null;
  const identifier = textOf(meta['dc:identifier'] ?? meta.identifier) || null;
  const publisher = textOf(meta['dc:publisher'] ?? meta.publisher) || null;

  const items = asArray(pkg.manifest.item) as OpfItem[];
  const byId = new Map(items.map((item) => [item['@_id'], item]));
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const tocTitles = new Map<string, string>();
  const navItem = items.find((item) => (item['@_properties'] ?? '').split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = resolveHref(opfDir, navItem['@_href'] ?? '');
    const navFile = zip.file(navPath);
    if (navFile) {
      const navHtml = await navFile.async('string');
      for (const anchor of parseAnchors(navHtml)) {
        tocTitles.set(resolveHref(opfDir, anchor.href), anchor.label);
      }
      if (!tocTitles.size) warnings.push('nav_unparsable');
    } else {
      warnings.push('nav_unparsable');
    }
  }

  if (!tocTitles.size) {
    const ncxId = pkg.spine['@_toc'];
    const ncxItem =
      (ncxId ? byId.get(ncxId) : undefined) ??
      items.find(
        (item) =>
          (item['@_media-type'] ?? '') === 'application/x-dtbncx+xml' ||
          /\.ncx$/i.test(item['@_href'] ?? ''),
      );
    if (ncxItem) {
      const ncxPath = resolveHref(opfDir, ncxItem['@_href'] ?? '');
      const ncxFile = zip.file(ncxPath);
      if (ncxFile) {
        try {
          const ncx = parser.parse(await ncxFile.async('string')) as { ncx?: Record<string, unknown> };
          const points: NavPoint[] = [];
          collectNcxPoints(ncx.ncx?.navMap, points);
          for (const point of points) {
            tocTitles.set(resolveHref(opfDir, point.href), point.label);
          }
          if (!tocTitles.size) warnings.push('nav_unparsable');
        } catch {
          warnings.push('nav_unparsable');
        }
      }
    }
  }

  const spineRefs = asArray(pkg.spine.itemref)
    .map((ref) => ref['@_idref'])
    .filter((id): id is string => !!id);

  const chapters: EpubChapter[] = [];
  let emptyChapters = 0;
  let duplicateWarned = false;
  const skippedTypes = new Set<string>();
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const idref of spineRefs) {
    if (seenIds.has(idref)) {
      if (!duplicateWarned) {
        warnings.push('duplicate_spine_item');
        duplicateWarned = true;
      }
      continue;
    }
    seenIds.add(idref);

    const item = byId.get(idref);
    if (!item) continue;
    const type = (item['@_media-type'] ?? '').toLowerCase();
    const href = item['@_href'] ?? '';

    if (/^(image|audio|video)\//.test(type) || type === 'text/css') {
      if (!skippedTypes.has(type)) {
        skippedTypes.add(type);
        warnings.push('skipped_non_text');
      }
      continue;
    }

    const isText = /xhtml|html|xml/.test(type) || /\.(x?html?|xml)$/i.test(href);
    if (!isText) {
      if (type) {
        if (!skippedTypes.has(type)) {
          skippedTypes.add(type);
          warnings.push('skipped_non_text');
        }
      }
      continue;
    }

    const path = resolveHref(opfDir, href);
    if (seenPaths.has(path)) {
      if (!duplicateWarned) {
        warnings.push('duplicate_spine_item');
        duplicateWarned = true;
      }
      continue;
    }
    seenPaths.add(path);

    const file = zip.file(path);
    if (!file) {
      warnings.push('missing_spine_item');
      continue;
    }

    const truncated = truncateChapter(await file.async('string'));
    if (truncated.truncated) warnings.push('chapter_truncated');
    const body = sanitizeHtml(extractBody(truncated.text));
    const text = htmlToText(body);
    const words = wordCount(text);
    if (words < 5) {
      emptyChapters += 1;
      continue;
    }
    chapters.push({
      ordinal: chapters.length,
      title: tocTitles.get(path) ?? chapterTitle(truncated.text, `Section ${chapters.length + 1}`),
      href: path,
      html: body,
      text,
      wordCount: words,
    });
  }

  if (emptyChapters > 0) warnings.push(`empty_chapter:${emptyChapters}`);
  if (!chapters.length) throw new EpubError('no_readable_chapters');

  return {
    title,
    author,
    language,
    identifier,
    publisher,
    chapters,
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    warnings,
  };
}
