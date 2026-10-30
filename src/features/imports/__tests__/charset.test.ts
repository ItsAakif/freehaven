import {
  decodeBytes,
  decodeLatin1,
  decodeWindows1252,
  detectCharset,
  utf8IsValid,
} from '@/features/imports/charset';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => ch.charCodeAt(0) & 0xff));
}

describe('charset detection', () => {
  it('detects and strips each BOM', () => {
    const utf8 = Uint8Array.from([0xef, 0xbb, 0xbf, ...ascii('Hello')]);
    const utf16le = Uint8Array.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    const utf16be = Uint8Array.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);

    expect(detectCharset(utf8)).toMatchObject({ charset: 'utf-8', method: 'bom', bomLength: 3 });
    expect(detectCharset(utf16le)).toMatchObject({
      charset: 'utf-16le',
      method: 'bom',
      bomLength: 2,
    });
    expect(detectCharset(utf16be)).toMatchObject({
      charset: 'utf-16be',
      method: 'bom',
      bomLength: 2,
    });

    expect(decodeBytes(utf8).text).toBe('Hello');
    expect(decodeBytes(utf16le).text).toBe('Hi');
    expect(decodeBytes(utf16be).text).toBe('Hi');
    expect(decodeBytes(utf8).method).toBe('bom');
  });

  it('reads an XML declaration before content heuristics', () => {
    const prefix = ascii('<?xml version="1.0" encoding="ISO-8859-1"?><root>caf');
    const encoded = Uint8Array.from([...prefix, 0xe9, ...ascii('</root>')]);
    expect(detectCharset(encoded)).toMatchObject({ charset: 'latin-1', method: 'xml-decl' });
    const decoded = decodeBytes(encoded);
    expect(decoded.charset).toBe('latin-1');
    expect(decoded.text).toContain('café');
  });

  it('reads a meta charset in the first 4 KB', () => {
    const encoded = Uint8Array.from([
      ...ascii('<html><head><meta charset="windows-1252"></head><body>caf'),
      0xe9,
      ...ascii('</body></html>'),
    ]);
    expect(detectCharset(encoded)).toMatchObject({
      charset: 'windows-1252',
      method: 'meta',
    });
    expect(decodeBytes(encoded).text).toContain('café');
  });

  it('accepts valid UTF-8 and rejects overlongs and surrogates', () => {
    expect(utf8IsValid(ascii('plain ascii'))).toBe(true);
    expect(utf8IsValid(bytes(0xe2, 0x82, 0xac))).toBe(true);
    expect(utf8IsValid(bytes(0xf0, 0x9f, 0x98, 0x80))).toBe(true);
    // overlong '/' encoded as C0 AF
    expect(utf8IsValid(bytes(0xc0, 0xaf))).toBe(false);
    // UTF-8 encoded surrogate half
    expect(utf8IsValid(bytes(0xed, 0xa0, 0x80))).toBe(false);
    // truncated sequence
    expect(utf8IsValid(bytes(0xe2, 0x82))).toBe(false);
  });

  it('decodes CP1252 punctuation', () => {
    const encoded = bytes(0x93, 0x48, 0x69, 0x94, 0x20, 0x96, 0x20, 0x85);
    const decoded = decodeWindows1252(encoded);
    expect(decoded).toBe('“Hi” – …');
    const result = decodeBytes(encoded);
    expect(result.charset).toBe('windows-1252');
    expect(result.method).toBe('cp1252-fallback');
    expect(result.replacementCount).toBe(0);
  });

  it('decodes Latin-1 accents without replacement characters', () => {
    const encoded = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeLatin1(encoded)).toBe('café');
    const result = decodeBytes(encoded);
    expect(result.text).toBe('café');
    expect(result.replacementCount).toBe(0);
    expect(result.hadErrors).toBe(false);
    // Per the fixture contract a pure Latin-1 file is decoded through the
    // CP1252 table (identical for 0xA0–0xFF) and labelled accordingly.
    expect(result.charset).toBe('windows-1252');
    expect(result.method).toBe('cp1252-fallback');
  });

  it('falls back to latin-1 when a byte is undefined in CP1252', () => {
    const encoded = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x81]);
    const result = decodeBytes(encoded);
    expect(result.charset).toBe('latin-1');
    expect(result.method).toBe('latin1-fallback');
    expect(result.text).toBe('café\u0081');
  });
});
