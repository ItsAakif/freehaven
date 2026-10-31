/**
 * Typed wrapper around the local `pdf-text` Expo module.
 *
 * The native extractor lives behind an injectable seam so the import pipeline
 * can be tested in Node without a device. `extractPdfPagesNative` converts a
 * `file://` URI to the absolute path PdfBox expects, parses the JSON string
 * returned by Kotlin and returns null for every unavailable/failed case. The
 * caller falls back to the pure-JS content-stream parser on null.
 */

import * as pdfTextModule from '../../../modules/pdf-text';

export type PdfTextPage = { page: number; text: string };
export type PdfTextOutlineItem = { title: string; page: number };

export type PdfTextModuleLike = {
  isPdfTextAvailable(): boolean;
  extractPdfPages(path: string): Promise<string | null>;
  extractOutline?(path: string): Promise<string | null>;
};

let override: PdfTextModuleLike | null = null;

/** Test seam. Pass `null` to restore the real optional native module. */
export function setPdfTextModuleForTests(module: PdfTextModuleLike | null): void {
  override = module;
}

function activeModule(): PdfTextModuleLike {
  return override ?? pdfTextModule;
}

/** Convert `file:///a%20b.pdf` to `/a b.pdf`; other URIs are returned decoded. */
export function pdfUriToFilePath(uri: string): string {
  const withoutScheme = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

function parsePages(json: string | null): PdfTextPage[] | null {
  if (typeof json !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;

  const pages: PdfTextPage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { page?: unknown; text?: unknown };
    pages.push({
      page: typeof record.page === 'number' ? record.page : pages.length + 1,
      text: typeof record.text === 'string' ? record.text : '',
    });
  }
  return pages;
}

/** Native pages, or null when the module is absent, fails or returns junk. */
export async function extractPdfPagesNative(
  sourceUri: string,
): Promise<PdfTextPage[] | null> {
  try {
    const module = activeModule();
    if (!module.isPdfTextAvailable()) return null;
    const json = await module.extractPdfPages(pdfUriToFilePath(sourceUri));
    return parsePages(json);
  } catch {
    return null;
  }
}

function parseOutline(json: string | null): PdfTextOutlineItem[] | null {
  if (typeof json !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;

  const items: PdfTextOutlineItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { title?: unknown; page?: unknown };
    if (typeof record.title !== 'string' || !record.title.trim()) continue;
    if (typeof record.page !== 'number' || !Number.isFinite(record.page)) continue;
    items.push({ title: record.title.trim(), page: Math.trunc(record.page) });
  }
  return items.length ? items : null;
}

/** Native outline, or null when the module/method/JSON is unavailable. */
export async function extractPdfOutlineNative(
  sourceUri: string,
): Promise<PdfTextOutlineItem[] | null> {
  try {
    const module = activeModule();
    if (!module.isPdfTextAvailable()) return null;
    if (typeof module.extractOutline !== 'function') return null;
    const json = await module.extractOutline(pdfUriToFilePath(sourceUri));
    return parseOutline(json);
  } catch {
    return null;
  }
}
