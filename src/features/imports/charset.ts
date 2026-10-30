/**
 * Byte-level charset detection and decoding.
 *
 * Pure module with no `TextDecoder` dependency: Hermes does not guarantee
 * legacy encodings, and owning the decoder makes the Latin-1 path testable in
 * Node and on device with exactly the same code.
 */

export type SupportedCharset = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | 'latin-1';

export type DecodeMethod =
  | 'bom'
  | 'meta'
  | 'xml-decl'
  | 'utf8-valid'
  | 'cp1252-fallback'
  | 'latin1-fallback';

export type DecodeResult = {
  text: string;
  charset: SupportedCharset;
  method: DecodeMethod;
  hadErrors: boolean;
  replacementCount: number;
};

export type CharsetDetection = {
  charset: string;
  method: 'bom' | 'meta' | 'xml-decl' | 'utf8-valid' | 'cp1252' | 'latin1';
  bomLength: number;
};

/** CP1252 defines punctuation at 0x80–0x9F; a handful of codes are undefined. */
const CP1252_HIGH: Record<number, string> = {
  0x80: '\u20ac',
  0x82: '\u201a',
  0x83: '\u0192',
  0x84: '\u201e',
  0x85: '\u2026',
  0x86: '\u2020',
  0x87: '\u2021',
  0x88: '\u02c6',
  0x89: '\u2030',
  0x8a: '\u0160',
  0x8b: '\u2039',
  0x8c: '\u0152',
  0x8e: '\u017d',
  0x91: '\u2018',
  0x92: '\u2019',
  0x93: '\u201c',
  0x94: '\u201d',
  0x95: '\u2022',
  0x96: '\u2013',
  0x97: '\u2014',
  0x98: '\u02dc',
  0x99: '\u2122',
  0x9a: '\u0161',
  0x9b: '\u203a',
  0x9c: '\u0153',
  0x9e: '\u017e',
  0x9f: '\u0178',
};

function normaliseCharset(raw: string | null | undefined): SupportedCharset | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (value === 'utf-8' || value === 'utf8') return 'utf-8';
  if (value === 'utf-16le' || value === 'utf-16' || value === 'utf16le') return 'utf-16le';
  if (value === 'utf-16be' || value === 'utf16be') return 'utf-16be';
  if (value === 'windows-1252' || value === 'cp1252' || value === 'win-1252') {
    return 'windows-1252';
  }
  if (
    value === 'latin-1' ||
    value === 'latin1' ||
    value === 'iso-8859-1' ||
    value === 'iso8859-1' ||
    value === 'l1'
  ) {
    return 'latin-1';
  }
  // US-ASCII is a strict subset of UTF-8 for all byte sequences we accept.
  if (value === 'us-ascii' || value === 'ascii') return 'utf-8';
  return null;
}

function detectBom(bytes: Uint8Array): { charset: SupportedCharset; length: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { charset: 'utf-8', length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { charset: 'utf-16le', length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { charset: 'utf-16be', length: 2 };
  }
  return null;
}

/** Latin-1 view for ASCII-only header probes (meta/xml declarations). */
function asciiHead(bytes: Uint8Array, length: number): string {
  let out = '';
  const end = Math.min(bytes.length, length);
  for (let i = 0; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function charsetFromXmlDecl(head: string): string | null {
  const match = head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function charsetFromMeta(head: string): string | null {
  const direct = head.match(/<meta[^>]+charset\s*=\s*["']?([a-z0-9_\-]+)/i);
  if (direct) return direct[1];
  const content = head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([a-z0-9_\-]+)/i);
  return content ? content[1] : null;
}

/**
 * Strict UTF-8 walk. Rejects overlong encodings, surrogate halves, values over
 * U+10FFFF and truncated sequences. The range is half-open `[from, to)`.
 */
export function utf8IsValid(bytes: Uint8Array, from = 0, to = bytes.length): boolean {
  const start = Math.max(0, from);
  const end = Math.min(bytes.length, to);
  let i = start;
  while (i < end) {
    const first = bytes[i];
    if (first < 0x80) {
      i += 1;
      continue;
    }
    let needed: number;
    let min: number;
    let code: number;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      min = 0x80;
      code = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      min = 0x800;
      code = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      min = 0x10000;
      code = first & 0x07;
    } else {
      return false;
    }
    // The last continuation byte is at index `i + needed`; it must be < end.
    if (i + needed >= end) return false;
    for (let k = 1; k <= needed; k += 1) {
      const next = bytes[i + k];
      if (next === undefined || next < 0x80 || next > 0xbf) return false;
      code = (code << 6) | (next & 0x3f);
    }
    if (code < min || code > 0x10ffff) return false;
    if (code >= 0xd800 && code <= 0xdfff) return false;
    i += needed + 1;
  }
  return true;
}

/** True when every byte in 0x80–0x9F is a defined CP1252 code point. */
function cp1252IsDefined(bytes: Uint8Array, from = 0, to = bytes.length): boolean {
  const end = Math.min(bytes.length, to);
  for (let i = Math.max(0, from); i < end; i += 1) {
    const byte = bytes[i];
    if (byte >= 0x80 && byte <= 0x9f && CP1252_HIGH[byte] === undefined) return false;
  }
  return true;
}

function hasCp1252HighByte(bytes: Uint8Array, from = 0, to = bytes.length): boolean {
  const end = Math.min(bytes.length, to);
  for (let i = Math.max(0, from); i < end; i += 1) {
    if (bytes[i] >= 0x80 && bytes[i] <= 0x9f) return true;
  }
  return false;
}

/** Align a range start forward past UTF-8 continuation bytes. */
function alignStart(bytes: Uint8Array, index: number): number {
  let i = Math.max(0, index);
  while (i < bytes.length && (bytes[i] & 0xc0) === 0x80) i += 1;
  return i;
}

export function detectCharset(bytes: Uint8Array, sample = 256 * 1024): CharsetDetection {
  const bom = detectBom(bytes);
  if (bom) return { charset: bom.charset, method: 'bom', bomLength: bom.length };

  const head = asciiHead(bytes, 4 * 1024);
  const xml = charsetFromXmlDecl(head.slice(0, 1024));
  if (xml) return { charset: normaliseCharset(xml) ?? xml.trim(), method: 'xml-decl', bomLength: 0 };

  const meta = charsetFromMeta(head);
  if (meta) return { charset: normaliseCharset(meta) ?? meta.trim(), method: 'meta', bomLength: 0 };

  const firstEnd = Math.min(bytes.length, Math.max(0, sample));
  const lastStart = alignStart(bytes, Math.max(0, bytes.length - 4 * 1024));
  if (utf8IsValid(bytes, 0, firstEnd) && utf8IsValid(bytes, lastStart, bytes.length)) {
    return { charset: 'utf-8', method: 'utf8-valid', bomLength: 0 };
  }

  if (hasCp1252HighByte(bytes) && cp1252IsDefined(bytes)) {
    return { charset: 'windows-1252', method: 'cp1252', bomLength: 0 };
  }
  return { charset: 'latin-1', method: 'latin1', bomLength: 0 };
}

function decodeUtf8(bytes: Uint8Array, offset: number): {
  text: string;
  replacementCount: number;
} {
  let out = '';
  let replacements = 0;
  let i = offset;
  while (i < bytes.length) {
    const first = bytes[i];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      i += 1;
      continue;
    }
    let needed: number;
    let min: number;
    let code: number;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      min = 0x80;
      code = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      min = 0x800;
      code = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      min = 0x10000;
      code = first & 0x07;
    } else {
      out += '\ufffd';
      replacements += 1;
      i += 1;
      continue;
    }
    let ok = true;
    for (let k = 1; k <= needed; k += 1) {
      const next = bytes[i + k];
      if (next === undefined || next < 0x80 || next > 0xbf) {
        ok = false;
        break;
      }
      code = (code << 6) | (next & 0x3f);
    }
    if (!ok || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += '\ufffd';
      replacements += 1;
      i += 1;
      continue;
    }
    out += String.fromCodePoint(code);
    i += needed + 1;
  }
  return { text: out, replacementCount: replacements };
}

function decodeUtf16(bytes: Uint8Array, offset: number, bigEndian: boolean): {
  text: string;
  replacementCount: number;
} {
  let out = '';
  let replacements = 0;
  let i = offset;
  while (i + 1 < bytes.length) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const unit = bigEndian ? (a << 8) | b : a | (b << 8);
    out += String.fromCharCode(unit);
    i += 2;
  }
  if (i < bytes.length) {
    out += '\ufffd';
    replacements += 1;
  }
  return { text: out, replacementCount: replacements };
}

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte >= 0x80 && byte <= 0x9f) {
      out += CP1252_HIGH[byte] ?? '\ufffd';
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/** Latin-1 = ISO-8859-1, decoded in chunks to stay under argument limits. */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8 * 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    out += String.fromCharCode(...slice);
  }
  return out;
}

function resultFor(
  text: string,
  charset: SupportedCharset,
  method: DecodeMethod,
  replacementCount: number,
): DecodeResult {
  return {
    text,
    charset,
    method,
    hadErrors: replacementCount > 0,
    replacementCount,
  };
}

export function decodeBytes(bytes: Uint8Array, hint: { charset?: string | null } = {}): DecodeResult {
  const bom = detectBom(bytes);
  if (bom) {
    if (bom.charset === 'utf-8') {
      const decoded = decodeUtf8(bytes, bom.length);
      return resultFor(decoded.text, 'utf-8', 'bom', decoded.replacementCount);
    }
    const decoded = decodeUtf16(bytes, bom.length, bom.charset === 'utf-16be');
    return resultFor(decoded.text, bom.charset, 'bom', decoded.replacementCount);
  }

  const hinted = normaliseCharset(hint.charset);
  if (hinted && (hinted !== 'utf-8' || utf8IsValid(bytes))) {
    if (hinted === 'utf-8') {
      const decoded = decodeUtf8(bytes, 0);
      return resultFor(decoded.text, 'utf-8', 'meta', decoded.replacementCount);
    }
    if (hinted === 'utf-16le' || hinted === 'utf-16be') {
      const decoded = decodeUtf16(bytes, 0, hinted === 'utf-16be');
      return resultFor(decoded.text, hinted, 'meta', decoded.replacementCount);
    }
    if (hinted === 'windows-1252') {
      return resultFor(decodeWindows1252(bytes), 'windows-1252', 'meta', 0);
    }
    return resultFor(decodeLatin1(bytes), 'latin-1', 'meta', 0);
  }

  const detection = detectCharset(bytes);
  const detected = normaliseCharset(detection.charset);
  const method: DecodeMethod =
    detection.method === 'bom'
      ? 'bom'
      : detection.method === 'meta'
        ? 'meta'
        : detection.method === 'xml-decl'
          ? 'xml-decl'
          : detection.method === 'utf8-valid'
            ? 'utf8-valid'
            : detection.method === 'cp1252'
              ? 'cp1252-fallback'
              : 'latin1-fallback';

  if (detected === 'utf-8') {
    const decoded = decodeUtf8(bytes, 0);
    return resultFor(decoded.text, 'utf-8', method, decoded.replacementCount);
  }
  if (detected === 'utf-16le' || detected === 'utf-16be') {
    const decoded = decodeUtf16(bytes, 0, detected === 'utf-16be');
    return resultFor(decoded.text, detected, method, decoded.replacementCount);
  }
  if (detection.method === 'xml-decl' || detection.method === 'meta') {
    if (detected === 'latin-1') {
      return resultFor(decodeLatin1(bytes), 'latin-1', 'meta', 0);
    }
    if (detected === 'windows-1252') {
      return resultFor(decodeWindows1252(bytes), 'windows-1252', 'meta', 0);
    }
  }

  // CP1252 is a superset of Latin-1 for 0xA0–0xFF. Decode as CP1252 whenever
  // every high control byte is defined; only true ISO-8859-1 files containing
  // undefined CP1252 codes need the Latin-1 fallback.
  if (cp1252IsDefined(bytes)) {
    return resultFor(decodeWindows1252(bytes), 'windows-1252', 'cp1252-fallback', 0);
  }
  return resultFor(decodeLatin1(bytes), 'latin-1', 'latin1-fallback', 0);
}
