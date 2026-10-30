import JSZip from 'jszip';
import { EpubError, parseEpub, resolveHref } from '@/features/imports/epub';
import { malformedEpub, validEpub } from './fixtures/gutenberg';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const CHAPTER = `<html><body><h1>Only Chapter</h1><p>Attention is the taking possession of the mind in clear and vivid form.</p><p>It implies withdrawal from some things in order to deal with others.</p></body></html>`;

async function buildZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array' });
}

function customOpf(options: {
  manifest: string;
  spine: string;
  toc?: string;
}): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Custom</dc:title></metadata>
  <manifest>${options.manifest}</manifest>
  <spine${options.toc ? ` toc="${options.toc}"` : ''}>${options.spine}</spine>
</package>`;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(EpubError);
    return (error as EpubError).code;
  }
}

describe('EPUB robustness', () => {
  it('throws the exact code for each malformed structure', async () => {
    expect(await codeOf(parseEpub(await malformedEpub('no-container')))).toBe('missing_container');
    expect(await codeOf(parseEpub(await malformedEpub('no-opf')))).toBe('missing_opf');
    expect(await codeOf(parseEpub(await malformedEpub('bad-spine')))).toBe('malformed_opf');
    expect(await codeOf(parseEpub(await malformedEpub('drm')))).toBe('drm_protected');
    expect(await codeOf(parseEpub(await malformedEpub('missing-chapter')))).toBe(
      'no_readable_chapters',
    );
  });

  it('rejects a zip with too many entries', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    for (let i = 0; i < 5_001; i += 1) zip.file(`f${i}.txt`, 'x');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    expect(await codeOf(parseEpub(bytes))).toBe('too_large');
  });

  it('accepts font obfuscation and reads normal chapters in spine order', async () => {
    const book = await parseEpub(await validEpub(['<p>First chapter words are here for reading.</p>', '<p>Second chapter words are here too.</p>']));
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe('Chapter 1');
    expect(book.chapters[1].title).toBe('Chapter 2');
  });

  it('de-duplicates a repeated spine idref', async () => {
    const bytes = await buildZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': customOpf({
        manifest: '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="c1"/><itemref idref="c1"/>',
      }),
      'OEBPS/ch1.xhtml': CHAPTER,
    });
    const book = await parseEpub(bytes);
    expect(book.chapters).toHaveLength(1);
    expect(book.warnings).toContain('duplicate_spine_item');
  });

  it('falls back to the NCX for TOC titles', async () => {
    const bytes = await buildZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': customOpf({
        manifest:
          '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="c1"/>',
        toc: 'ncx',
      }),
      'OEBPS/toc.ncx': `<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
          <navMap><navPoint id="p1"><navLabel><text>First Lesson</text></navLabel>
            <content src="ch1.xhtml"/></navPoint></navMap>
        </ncx>`,
      'OEBPS/ch1.xhtml': CHAPTER,
    });
    const book = await parseEpub(bytes);
    expect(book.chapters[0].title).toBe('First Lesson');
  });

  it('does not throw when the nav document is missing', async () => {
    const bytes = await buildZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': customOpf({
        manifest: '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="c1"/>',
      }),
      'OEBPS/ch1.xhtml': CHAPTER,
    });
    const book = await parseEpub(bytes);
    expect(book.chapters[0].title).toBe('Only Chapter');
  });

  it('counts empty chapters and keeps readable ones', async () => {
    const bytes = await buildZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': customOpf({
        manifest:
          '<item id="empty" href="empty.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="empty"/><itemref idref="c1"/>',
      }),
      'OEBPS/empty.xhtml': '<html><body><p>tiny</p></body></html>',
      'OEBPS/ch1.xhtml': CHAPTER,
    });
    const book = await parseEpub(bytes);
    expect(book.chapters).toHaveLength(1);
    expect(book.warnings).toContain('empty_chapter:1');
  });

  it('clamps parent-directory hrefs inside the zip root', () => {
    expect(resolveHref('OEBPS/text', '../../../../etc/passwd')).toBe('etc/passwd');
    expect(resolveHref('OEBPS', '/OEBPS/ch1.xhtml')).toBe('OEBPS/ch1.xhtml');
    expect(resolveHref('OEBPS', 'bad%zz.xhtml')).toBe('OEBPS/bad%zz.xhtml');
  });
});
