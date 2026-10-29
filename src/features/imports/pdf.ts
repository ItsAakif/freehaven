/**
 * Best-effort PDF text extraction.
 *
 * This is intentionally a *text layer* reader, not a layout engine: it walks the
 * page content streams, inflates FlateDecode data and reads the text-showing
 * operators (Tj, TJ, ' and "). It works well for digitally generated PDFs with
 * simple fonts; scanned pages and CID/Type0 fonts with custom encodings may
 * produce no text or mojibake, and are reported as warnings rather than silently
 * "succeeding". Page numbers are preserved so highlights and citations stay
 * anchored.
 */

import { PDFDocument } from 'pdf-lib';
import { inflate } from 'pako';
import { normalizeWhitespace, wordCount } from '@/domain/text';

export type PdfPageText = { page: number; text: string };
export type PdfBook = {
  title: string | null;
  author: string | null;
  pageCount: number;
  pages: PdfPageText[];
  totalWords: number;
  warnings: string[];
  extractor: 'content-stream';
};

function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

function printable(text: string): boolean {
  if (!text) return false;
  const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return letters / text.length > 0.35;
}

/** Decode PDF literal string escapes. */
export function decodePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    switch (next) {
      case 'n':
        out += '\n';
        i += 1;
        break;
      case 'r':
        out += '\r';
        i += 1;
        break;
      case 't':
        out += '\t';
        i += 1;
        break;
      case 'b':
      case 'f':
        i += 1;
        break;
      case '(':
      case ')':
      case '\\':
        out += next;
        i += 1;
        break;
      case '\n':
        i += 1;
        break;
      default:
        if (/[0-7]/.test(next)) {
          const octal = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? '';
          out += String.fromCharCode(parseInt(octal, 8));
          i += octal.length;
        } else {
          out += next;
          i += 1;
        }
    }
  }
  return out;
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) bytes.push(parseInt(padded.slice(i, i + 2), 16));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return bytes.map((b) => String.fromCharCode(b)).join('');
}

/** Read text-showing operators out of one decoded content stream. */
export function extractTextFromContentStream(content: string): string {
  const parts: string[] = [];
  // Literal strings followed by Tj / ' / " and arrays followed by TJ.
  const re = /\((?:\\.|[^\\()])*\)\s*(Tj|'|")|\[((?:[^\[\]]|\((?:\\.|[^\\()])*\))*)\]\s*TJ|<([0-9a-fA-F\s]+)>\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    if (match[3]) {
      const decoded = decodeHexString(match[3]);
      if (decoded.trim()) parts.push(decoded);
      continue;
    }
    if (match[2]) {
      const inner = match[2];
      const stringRe = /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>/g;
      let s: RegExpExecArray | null;
      let line = '';
      while ((s = stringRe.exec(inner))) {
        const token = s[0];
        if (token.startsWith('<')) line += decodeHexString(token.slice(1, -1));
        else line += decodePdfString(token.slice(1, -1));
      }
      if (line.trim()) parts.push(line);
      continue;
    }
    if (match[1]) {
      const token = match[0].slice(0, match[0].lastIndexOf(match[1])).trim();
      const decoded = decodePdfString(token.slice(1, -1));
      if (match[1] === "'" || match[1] === '"') parts.push('\n');
      if (decoded.trim()) parts.push(decoded);
    }
  }
  return normalizeWhitespace(parts.join(' '));
}

function decodeStream(dict: string, raw: Uint8Array): string | null {
  try {
    if (/\/FlateDecode/.test(dict)) {
      return bytesToLatin1(inflate(raw));
    }
    if (/\/Filter/.test(dict)) return null;
    return bytesToLatin1(raw);
  } catch {
    return null;
  }
}

type PdfObject = { num: number; dict: string; stream?: Uint8Array };

function collectObjects(source: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const num = Number(match[1]);
    let body = match[2];
    let stream: Uint8Array | undefined;
    const streamStart = body.indexOf('stream');
    if (streamStart !== -1) {
      const dict = body.slice(0, streamStart);
      let dataStart = streamStart + 'stream'.length;
      if (body[dataStart] === '\r') dataStart += 1;
      if (body[dataStart] === '\n') dataStart += 1;
      const end = body.lastIndexOf('endstream');
      if (end > dataStart) {
        const raw = body.slice(dataStart, end).replace(/\r?\n$/, '');
        stream = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff);
        body = dict;
      }
    }
    objects.set(num, { num, dict: body, stream });
  }
  return objects;
}

export async function parsePdf(bytes: Uint8Array): Promise<PdfBook> {
  const warnings: string[] = [];
  let pageCount = 0;
  let title: string | null = null;
  let author: string | null = null;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    pageCount = doc.getPageCount();
    title = doc.getTitle() ?? null;
    author = doc.getAuthor() ?? null;
  } catch {
    warnings.push('The PDF structure could not be fully parsed; text extraction may be incomplete.');
  }

  const source = bytesToLatin1(bytes);
  const objects = collectObjects(source);
  const pageObjects = [...objects.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.dict));

  const pages: PdfPageText[] = [];
  const pushPage = (text: string) => {
    const clean = normalizeWhitespace(text);
    if (!clean || !printable(clean)) return;
    pages.push({ page: pages.length + 1, text: clean });
  };

  if (pageObjects.length) {
    for (const page of pageObjects) {
      const contentsMatch = page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/);
      if (!contentsMatch) {
        pushPage('');
        continue;
      }
      const refs = [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
      const text = refs
        .map((ref) => {
          const object = objects.get(ref);
          if (!object?.stream) return '';
          const decoded = decodeStream(object.dict, object.stream);
          return decoded ? extractTextFromContentStream(decoded) : '';
        })
        .join('\n');
      pushPage(text);
    }
  } else {
    warnings.push('No page objects were found (the PDF may use object streams). Falling back to stream order.');
    for (const object of objects.values()) {
      if (!object.stream) continue;
      const decoded = decodeStream(object.dict, object.stream);
      if (!decoded || !/\bBT\b/.test(decoded)) continue;
      pushPage(extractTextFromContentStream(decoded));
    }
  }

  if (!pages.length) {
    throw new Error(
      'No text layer was found. This PDF is probably a scan. OCR is not available in this build; you can still open the original file in your device viewer.',
    );
  }
  if (pageCount && pages.length < pageCount) {
    warnings.push(`Text was recovered from ${pages.length} of ${pageCount} pages.`);
  }
  if (!printable(pages.map((p) => p.text).join(' '))) {
    warnings.push('The extracted text looks like a non-Latin encoding; expect unreadable output.');
  }

  return {
    title,
    author,
    pageCount: pageCount || pages.length,
    pages,
    totalWords: pages.reduce((sum, p) => sum + wordCount(p.text), 0),
    warnings,
    extractor: 'content-stream',
  };
}
