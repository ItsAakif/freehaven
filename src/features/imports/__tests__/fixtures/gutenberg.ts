/**
 * Deterministic import fixtures. Builders only — no binary files in the repo.
 *
 * Used by the offline Jest suites and mirrored by the Node conformance harness
 * where a fixture is synthetic.
 */

import JSZip from 'jszip';

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0) & 0xff);
}

function concat(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

export function emptyBytes(): Uint8Array {
  return new Uint8Array();
}

export function pngBytes(): Uint8Array {
  return concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0, 0, 0, 0, 0]);
}

export function garbageBytes(): Uint8Array {
  // Mostly control bytes with an occasional ASCII letter: printableRatio stays
  // well below the 0.60 gate while a few "words" exist.
  const out = new Uint8Array(1024);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = i % 100 === 0 ? 0x78 : (i * 7) % 0x20;
  }
  return out;
}

/** "café" encoded as ISO-8859-1 (0xE9), padded to ~3 KB, no BOM or meta. */
export function latin1TextBytes(): Uint8Array {
  const line = concat(
    ascii('The caf'),
    [0xe9],
    ascii(' was small and quiet. The na'),
    [0xef],
    ascii('ve reader paused.\n'),
  );
  const out: number[] = [];
  while (out.length < 3 * 1024) out.push(...line);
  return Uint8Array.from(out);
}

/** HTML with an explicit windows-1252 meta and CP1252 curly quotes. */
export function latin1HtmlWithMeta(): Uint8Array {
  const body = concat(
    ascii('<html><head><meta charset="windows-1252"><title>Caf'),
    [0xe9],
    ascii('</title></head><body><p>'),
    [0x93],
    ascii('Quoted'),
    [0x94],
    ascii(' text with a caf'),
    [0xe9],
    ascii('.</p></body></html>'),
  );
  return Uint8Array.from(body);
}

export function utf8BomText(): Uint8Array {
  return concat([0xef, 0xbb, 0xbf], ascii('Café — a UTF-8 text with a BOM.\n'.repeat(40)));
}

const BODY =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.';

export function missingMarkersText(): string {
  return `Produced by Someone\n\n${BODY}\n\n${BODY}\n\nThe text ends without any licence markers.`;
}

export function startOnlyText(): string {
  return `*** START OF THE PROJECT GUTENBERG EBOOK ***\n\n${BODY}`;
}

export function endBeforeStartText(): string {
  return `*** END OF THE PROJECT GUTENBERG EBOOK ***\n\n${BODY}\n\n*** START OF THE PROJECT GUTENBERG EBOOK ***`;
}

export function htmlOnlyBook(): string {
  return `<!doctype html>
<html><head><title>An HTML-only Book</title>
<meta charset="utf-8">
<style>body { color: black; }</style>
<script>window.tracker = true;</script>
</head>
<body>
<nav class="toc"><a href="#one">Contents</a></nav>
<!-- *** START OF THE PROJECT GUTENBERG EBOOK AN HTML-ONLY BOOK *** -->
<div class="pgheader">The Project Gutenberg eBook of An HTML-only Book</div>
<h1>Chapter One</h1>
<p>Attention is the taking possession of the mind &mdash; in clear and vivid form.</p>
<p>It implies withdrawal from some things in order to deal effectively with others.<br>Second line of the same verse.</p>
<ul><li>First item</li><li>Second item</li></ul>
<pre>Roses are red,
  violets are blue.</pre>
<footer class="pgfooter">Project Gutenberg footer</footer>
<!-- *** END OF THE PROJECT GUTENBERG EBOOK AN HTML-ONLY BOOK *** -->
</body></html>`;
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const CHAPTER_ONE = `<html><head><title>One</title></head><body><h1>One</h1>
<p>Attention is the taking possession of the mind, in clear and vivid form.</p>
<p>It implies withdrawal from some things in order to deal effectively with others.</p>
</body></html>`;

const CHAPTER_TWO = `<html><head><title>Two</title></head><body><h1>Two</h1>
<p>Several things do not interest me at once, and the mind can only hold a few ideas.</p>
</body></html>`;

function opf(options: { spine: string; extraManifest?: string; toc?: string } = { spine: '' }): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:creator>Ada Fixture</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    ${options.extraManifest ?? ''}
  </manifest>
  <spine${options.toc ? ` toc="${options.toc}"` : ''}>
    ${options.spine}
  </spine>
</package>`;
}

const NAV = `<html><body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">First</a></li>
  <li><a href="ch2.xhtml">Second</a></li>
</ol></nav></body></html>`;

async function zipBytes(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    // EPUB requires the `mimetype` entry to be stored uncompressed so magic
    // sniffing works without unzipping.
    zip.file(path, content, path === 'mimetype' ? { compression: 'STORE' } : undefined);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function malformedEpub(
  kind: 'no-container' | 'no-opf' | 'bad-spine' | 'missing-chapter' | 'drm',
): Promise<Uint8Array> {
  const base: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf({ spine: '<itemref idref="c1"/><itemref idref="c2"/>' }),
    'OEBPS/nav.xhtml': NAV,
    'OEBPS/ch1.xhtml': CHAPTER_ONE,
    'OEBPS/ch2.xhtml': CHAPTER_TWO,
  };

  if (kind === 'no-container') {
    delete base['META-INF/container.xml'];
  } else if (kind === 'no-opf') {
    delete base['OEBPS/content.opf'];
  } else if (kind === 'bad-spine') {
    base['OEBPS/content.opf'] = opf({ spine: '' }).replace(/<spine[^>]*>[\s\S]*?<\/spine>/, '');
  } else if (kind === 'missing-chapter') {
    base['OEBPS/content.opf'] = opf({ spine: '<itemref idref="c1"/>' });
    delete base['OEBPS/ch1.xhtml'];
  } else {
    base['META-INF/encryption.xml'] = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData><CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData>
</encryption>`;
  }

  return zipBytes(base);
}

/** A normal EPUB with the given chapter bodies, in spine order. */
export async function validEpub(chapters: string[]): Promise<Uint8Array> {
  const files: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/nav.xhtml': NAV,
    'META-INF/encryption.xml': `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData><CipherData><CipherReference URI="OEBPS/fonts/book.ttf"/></CipherData></EncryptedData>
</encryption>`,
  };
  chapters.forEach((body, index) => {
    files[`OEBPS/ch${index + 1}.xhtml`] = `<html><body><h1>Chapter ${index + 1}</h1>${body}</body></html>`;
  });
  const spine = chapters.map((_, index) => `<itemref idref="c${index + 1}"/>`).join('');
  const manifest = chapters
    .map((_, index) => `<item id="c${index + 1}" href="ch${index + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const nav = chapters
    .map((_, index) => `<li><a href="ch${index + 1}.xhtml">Chapter ${index + 1}</a></li>`)
    .join('');
  files['OEBPS/nav.xhtml'] = `<html><body><nav><ol>${nav}</ol></nav></body></html>`;
  files['OEBPS/content.opf'] = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Valid Fixture</dc:title><dc:creator>Ada Fixture</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest>
  <spine>${spine}</spine>
</package>`;
  return zipBytes(files);
}

/**
 * Deterministic prose whose length is at least `chars`. Sentences are short so
 * sentence splitting, chunking and planning exercise realistic boundaries.
 */
export function largeBook(chars = 600_000, seed = 1): string {
  const words = [
    'attention', 'memory', 'practice', 'reading', 'language', 'thought', 'habit', 'story',
    'question', 'answer', 'reason', 'evidence', 'chapter', 'reader', 'writer', 'history',
    'science', 'music', 'garden', 'morning', 'evening', 'distance', 'silence', 'signal',
  ];
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const sentences: string[] = [];
  let length = 0;
  while (length < chars) {
    const count = 8 + Math.floor(rand() * 8);
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) parts.push(words[Math.floor(rand() * words.length)]);
    const sentence = `${parts.join(' ')[0].toUpperCase()}${parts.join(' ').slice(1)}.`;
    sentences.push(sentence);
    length += sentence.length + 1;
    if (sentences.length % 7 === 0) {
      sentences.push('\n\n');
      length += 2;
    }
  }
  return sentences.join(' ');
}
