/**
 * Format sniffing from bytes.
 *
 * The URL, file name and media type are hints only: Project Gutenberg serves
 * `.txt` URLs that are HTML, EPUBs with no extension and legacy encodings.
 * Magic bytes win, then structure, then a conservative text heuristic.
 */

import { decodeBytes, detectCharset } from './charset';

export type SniffedFormat =
  | 'epub'
  | 'pdf'
  | 'html'
  | 'text'
  | 'image'
  | 'audio'
  | 'zip'
  | 'gzip'
  | 'unknown';

export type SniffConfidence = 'magic' | 'structure' | 'heuristic';

export type SniffResult = {
  format: SniffedFormat;
  confidence: SniffConfidence;
  /** From a BOM, XML declaration or HTML meta tag; null when inferred. */
  charset: string | null;
  looksBinary: boolean;
  /** Printable code points over the first 8 KB, after charset decode. */
  printableRatio: number;
  declared: { name: string | null; mime: string | null };
  reason: string | null;
};

export const MAX_TEXT_BYTES = 25 * 1024 * 1024;
export const MAX_HTML_BYTES = 25 * 1024 * 1024;
export const MAX_EPUB_BYTES = 80 * 1024 * 1024;
export const MAX_PDF_BYTES = 80 * 1024 * 1024;
export const SNIFF_SAMPLE_BYTES = 8 * 1024;

const EPUB_MIME = 'application/epub+zip';

function bytesAt(bytes: Uint8Array, offset: number, pattern: number[]): boolean {
  if (offset + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function indexOfAscii(bytes: Uint8Array, text: string, from: number, to: number): number {
  const pattern = [...text].map((ch) => ch.charCodeAt(0) & 0xff);
  const end = Math.min(bytes.length, to) - pattern.length;
  for (let i = Math.max(0, from); i <= end; i += 1) {
    if (bytesAt(bytes, i, pattern)) return i;
  }
  return -1;
}

/** A stored `mimetype` entry is enough to tell an EPUB zip from any other zip. */
function zipLooksLikeEpub(bytes: Uint8Array): boolean {
  const marker = indexOfAscii(bytes, 'mimetype', 0, Math.min(bytes.length, 64 * 1024));
  if (marker < 0) return false;
  return indexOfAscii(bytes, EPUB_MIME, marker, marker + 120) >= 0;
}

type Magic = { format: SniffedFormat; reason: string | null };

function magicAt(bytes: Uint8Array, offset: number): Magic | null {
  if (bytesAt(bytes, offset, [0x50, 0x4b, 0x03, 0x04]) || bytesAt(bytes, offset, [0x50, 0x4b, 0x05, 0x06])) {
    return zipLooksLikeEpub(bytes)
      ? { format: 'epub', reason: null }
      : { format: 'zip', reason: 'zip_not_epub' };
  }
  if (bytesAt(bytes, offset, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: 'pdf', reason: null };
  if (
    bytesAt(bytes, offset, [0x89, 0x50, 0x4e, 0x47]) ||
    bytesAt(bytes, offset, [0xff, 0xd8, 0xff]) ||
    bytesAt(bytes, offset, [0x47, 0x49, 0x46, 0x38])
  ) {
    return { format: 'image', reason: null };
  }
  if (bytesAt(bytes, offset, [0x52, 0x49, 0x46, 0x46]) && bytesAt(bytes, offset + 8, [0x57, 0x45, 0x42, 0x50])) {
    return { format: 'image', reason: null };
  }
  if (
    bytesAt(bytes, offset, [0x49, 0x44, 0x33]) ||
    bytesAt(bytes, offset, [0x4f, 0x67, 0x67, 0x53]) ||
    bytesAt(bytes, offset, [0x66, 0x4c, 0x61, 0x43])
  ) {
    return { format: 'audio', reason: null };
  }
  if (bytesAt(bytes, offset, [0x52, 0x49, 0x46, 0x46]) && bytesAt(bytes, offset + 8, [0x57, 0x41, 0x56, 0x45])) {
    return { format: 'audio', reason: null };
  }
  if (bytesAt(bytes, offset, [0x1f, 0x8b])) return { format: 'gzip', reason: 'gzip' };
  return null;
}

function isPrintable(ch: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]/u.test(ch);
}

function printableRatioOf(text: string): number {
  if (!text) return 0;
  const chars = Array.from(text);
  let printable = 0;
  for (const ch of chars) if (isPrintable(ch)) printable += 1;
  return printable / chars.length;
}

function hasNul(bytes: Uint8Array, limit: number): boolean {
  const end = Math.min(bytes.length, limit);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}

function looksLikeHtml(text: string): boolean {
  if (/^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text)) return true;
  const markers = [/<p[\s>]/i, /<div[\s>]/i, /<br[\s/>]/i, /<meta[\s>]/i, /<a\s+href/i];
  let hits = 0;
  for (const marker of markers) if (marker.test(text)) hits += 1;
  return hits >= 2;
}

function hintSuggestsText(hint: { name?: string | null; mime?: string | null } | undefined): boolean {
  if (!hint) return false;
  const name = (hint.name ?? '').toLowerCase();
  const mime = (hint.mime ?? '').toLowerCase();
  return (
    /\.(txt|md|html?|xhtml|xml|rst|text)$/.test(name) ||
    mime.startsWith('text/') ||
    mime === 'application/xhtml+xml'
  );
}

function sniffSample(bytes: Uint8Array): { text: string; charset: string | null } {
  const sample = bytes.subarray(0, SNIFF_SAMPLE_BYTES);
  const detection = detectCharset(bytes);
  const explicit =
    detection.method === 'bom' || detection.method === 'meta' || detection.method === 'xml-decl'
      ? detection.charset
      : null;
  const decoded = decodeBytes(sample);
  return { text: decoded.text, charset: explicit };
}

export function sniffBytes(
  bytes: Uint8Array,
  hint?: { name?: string | null; mime?: string | null },
): SniffResult {
  const declared = { name: hint?.name ?? null, mime: hint?.mime ?? null };

  if (!bytes.length) {
    return {
      format: 'unknown',
      confidence: 'magic',
      charset: null,
      looksBinary: false,
      printableRatio: 0,
      declared,
      reason: 'empty',
    };
  }

  const sample = sniffSample(bytes);
  const printableRatio = printableRatioOf(sample.text);
  const looksBinary = hasNul(bytes, SNIFF_SAMPLE_BYTES) || printableRatio < 0.9;

  const atZero = magicAt(bytes, 0);
  if (atZero) {
    return {
      format: atZero.format,
      confidence: 'magic',
      charset: sample.charset,
      looksBinary: atZero.format === 'image' || atZero.format === 'audio' ? true : looksBinary,
      printableRatio,
      declared,
      reason: atZero.reason,
    };
  }

  // UTF-16 text contains NUL bytes by construction; the BOM is authoritative.
  if (sample.charset === 'utf-16le' || sample.charset === 'utf-16be') {
    return {
      format: 'text',
      confidence: 'heuristic',
      charset: sample.charset,
      looksBinary: false,
      printableRatio,
      declared,
      reason: null,
    };
  }

  if (looksLikeHtml(sample.text)) {
    return {
      format: 'html',
      confidence: 'structure',
      charset: sample.charset,
      looksBinary,
      printableRatio,
      declared,
      reason: null,
    };
  }

  // PDF/HTML preceded by up to 1 KB of whitespace or NUL padding.
  const limit = Math.min(bytes.length, 1024);
  let offset = 0;
  while (offset < limit && (bytes[offset] === 0 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d || bytes[offset] === 0x20)) {
    offset += 1;
  }
  if (offset > 0) {
    const shifted = magicAt(bytes, offset);
    if (shifted) {
      return {
        format: shifted.format,
        confidence: 'magic',
        charset: sample.charset,
        looksBinary: shifted.format === 'image' || shifted.format === 'audio' ? true : looksBinary,
        printableRatio,
        declared,
        reason: shifted.reason,
      };
    }
  }

  if (printableRatio >= 0.9 && !hasNul(bytes, SNIFF_SAMPLE_BYTES)) {
    return {
      format: 'text',
      confidence: 'heuristic',
      charset: sample.charset,
      looksBinary: false,
      printableRatio,
      declared,
      reason: null,
    };
  }

  // Hints never raise confidence above `heuristic`; they only break a tie
  // between text and unknown for mostly-printable payloads.
  if (printableRatio >= 0.75 && hintSuggestsText(hint)) {
    return {
      format: 'text',
      confidence: 'heuristic',
      charset: sample.charset,
      looksBinary: false,
      printableRatio,
      declared,
      reason: null,
    };
  }

  return {
    format: 'unknown',
    confidence: 'heuristic',
    charset: sample.charset,
    looksBinary: true,
    printableRatio,
    declared,
    reason: 'binary',
  };
}
