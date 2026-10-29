/**
 * EPUB extraction.
 *
 * Parses the container → OPF → spine, pulls readable XHTML per chapter, and
 * produces sanitised chapter HTML plus plain text for search, summaries and
 * citations. No WebView or native module is involved, so this is fully testable.
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { normalizeWhitespace, wordCount } from '@/domain/text';

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

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Remove scripts, styles, iframes, event handlers and javascript: URLs. */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return normalizeWhitespace(decodeEntities(stripped)).replace(/\n{3,}/g, '\n\n');
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

/** Resolve a relative href against the OPF directory. */
export function resolveHref(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]);
  if (!baseDir) return clean.replace(/^\.\//, '');
  const parts = `${baseDir}/${clean}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

export async function parseEpub(bytes: Uint8Array | ArrayBuffer): Promise<EpubBook> {
  const zip = await JSZip.loadAsync(bytes);
  const warnings: string[] = [];

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This file is not a valid EPUB (missing META-INF/container.xml).');
  const containerXml = parser.parse(await containerFile.async('string')) as {
    container?: { rootfiles?: { rootfile?: { '@_full-path'?: string } | { '@_full-path'?: string }[] } };
  };
  const rootfile = asArray(containerXml.container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.['@_full-path'];
  if (!opfPath) throw new Error('EPUB package document could not be located.');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('EPUB package document is missing.');
  const opf = parser.parse(await opfFile.async('string')) as {
    package?: {
      metadata?: Record<string, unknown>;
      manifest?: { item?: OpfItem | OpfItem[] };
      spine?: { itemref?: { '@_idref'?: string } | { '@_idref'?: string }[] };
    };
  };
  const pkg = opf.package;
  if (!pkg?.manifest || !pkg.spine) throw new Error('EPUB package document is malformed.');

  const meta = pkg.metadata ?? {};
  const title = textOf(meta['dc:title'] ?? meta.title) || 'Untitled EPUB';
  const author = textOf(meta['dc:creator'] ?? meta.creator) || null;
  const language = textOf(meta['dc:language'] ?? meta.language) || null;
  const identifier = textOf(meta['dc:identifier'] ?? meta.identifier) || null;
  const publisher = textOf(meta['dc:publisher'] ?? meta.publisher) || null;

  const items = asArray(pkg.manifest.item) as OpfItem[];
  const byId = new Map(items.map((item) => [item['@_id'], item]));
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  // Build TOC titles from the nav document when present.
  const navItem = items.find((i) => (i['@_properties'] ?? '').includes('nav'));
  const tocTitles = new Map<string, string>();
  if (navItem) {
    const navPath = resolveHref(opfDir, navItem['@_href'] ?? '');
    const navFile = zip.file(navPath);
    if (navFile) {
      const navHtml = await navFile.async('string');
      const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(navHtml))) {
        const href = m[1].split('#')[0];
        const label = htmlToText(m[2]).trim();
        if (href && label) tocTitles.set(resolveHref(opfDir, href), label);
      }
    }
  }

  const spineRefs = asArray(pkg.spine.itemref)
    .map((ref) => ref['@_idref'])
    .filter((id): id is string => !!id);

  const chapters: EpubChapter[] = [];
  for (const idref of spineRefs) {
    const item = byId.get(idref);
    if (!item) continue;
    const type = item['@_media-type'] ?? '';
    if (!/xhtml|html/i.test(type + (item['@_href'] ?? ''))) continue;
    const path = resolveHref(opfDir, item['@_href'] ?? '');
    const file = zip.file(path);
    if (!file) {
      warnings.push(`Missing spine item: ${path}`);
      continue;
    }
    const raw = await file.async('string');
    const body = sanitizeHtml(extractBody(raw));
    const text = htmlToText(body);
    if (wordCount(text) < 5) continue;
    chapters.push({
      ordinal: chapters.length,
      title: tocTitles.get(path) ?? chapterTitle(raw, `Section ${chapters.length + 1}`),
      href: path,
      html: body,
      text,
      wordCount: wordCount(text),
    });
  }

  if (!chapters.length) throw new Error('No readable chapters were found in this EPUB.');

  return {
    title,
    author,
    language,
    identifier,
    publisher,
    chapters,
    totalWords: chapters.reduce((sum, c) => sum + c.wordCount, 0),
    warnings,
  };
}

type OpfItem = {
  '@_id'?: string;
  '@_href'?: string;
  '@_media-type'?: string;
  '@_properties'?: string;
};
