import { sniffBytes } from '@/features/imports/sniff';

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0) & 0xff);
}

function bytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];

function epubZip(): Uint8Array {
  return bytes(ZIP, ascii('mimetype'), ascii('application/epub+zip'));
}

function plainZip(): Uint8Array {
  return bytes(ZIP, ascii('hello.txt'), ascii('not an epub'));
}

describe('sniffBytes', () => {
  it('recognises an EPUB zip and a plain zip', () => {
    expect(sniffBytes(epubZip())).toMatchObject({ format: 'epub', confidence: 'magic' });
    expect(sniffBytes(plainZip())).toMatchObject({
      format: 'zip',
      confidence: 'magic',
      reason: 'zip_not_epub',
    });
  });

  it('recognises PDF magic bytes', () => {
    const pdf = bytes([0x25, 0x50, 0x44, 0x46, 0x2d], ascii('1.7\n%PDF body'));
    expect(sniffBytes(pdf).format).toBe('pdf');
  });

  it('recognises images', () => {
    expect(sniffBytes(bytes([0x89, 0x50, 0x4e, 0x47], [0, 0, 0, 0])).format).toBe('image');
    expect(sniffBytes(bytes([0xff, 0xd8, 0xff, 0xe0], [0, 0])).format).toBe('image');
    expect(sniffBytes(bytes(ascii('GIF89a'), [0, 0])).format).toBe('image');
    expect(
      sniffBytes(bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'), [0, 0])).format,
    ).toBe('image');
  });

  it('recognises audio containers', () => {
    expect(sniffBytes(bytes(ascii('ID3'), [4, 0])).format).toBe('audio');
    expect(sniffBytes(bytes(ascii('OggS'), [0, 0])).format).toBe('audio');
    expect(sniffBytes(bytes(ascii('fLaC'), [0, 0])).format).toBe('audio');
    expect(
      sniffBytes(bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WAVE'), [0, 0])).format,
    ).toBe('audio');
  });

  it('flags gzip as unsupported with a reason', () => {
    expect(sniffBytes(bytes([0x1f, 0x8b, 0x08], [0, 0]))).toMatchObject({
      format: 'gzip',
      reason: 'gzip',
    });
  });

  it('detects HTML by structure', () => {
    const html = bytes(ascii('<!doctype html><html><head><title>x</title></head><body><p>Hi</p></body></html>'));
    expect(sniffBytes(html)).toMatchObject({ format: 'html', confidence: 'structure' });
  });

  it('detects UTF-8 prose by heuristic', () => {
    const prose = bytes(ascii('It was the best of times, it was the worst of times. '.repeat(20)));
    expect(sniffBytes(prose)).toMatchObject({ format: 'text', confidence: 'heuristic' });
  });

  it('reports empty and binary payloads', () => {
    expect(sniffBytes(new Uint8Array())).toMatchObject({ format: 'unknown', reason: 'empty' });
    const binary = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 0x80) & 0xff);
    expect(sniffBytes(binary)).toMatchObject({ format: 'unknown', reason: 'binary' });
  });

  it('never lets a file-name hint override magic', () => {
    const prose = bytes(ascii('This is plain text, not an EPUB archive. '.repeat(10)));
    const result = sniffBytes(prose, { name: 'book.epub', mime: 'application/epub+zip' });
    expect(result.format).toBe('text');
    expect(result.confidence).toBe('heuristic');
    expect(result.declared).toEqual({ name: 'book.epub', mime: 'application/epub+zip' });
  });

  it('retries magic after leading whitespace', () => {
    const padded = bytes([0x20, 0x0a, 0x00], [0x25, 0x50, 0x44, 0x46, 0x2d], ascii('1.4'));
    expect(sniffBytes(padded).format).toBe('pdf');
  });
});
