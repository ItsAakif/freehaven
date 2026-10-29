import JSZip from 'jszip';
import { parseEpub, resolveHref, sanitizeHtml } from '@/features/imports/epub';

async function buildEpub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
     <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
       <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
     </container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?>
     <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
         <dc:title>The Test Book</dc:title>
         <dc:creator>Ada Lovelace</dc:creator>
         <dc:language>en</dc:language>
         <dc:identifier>urn:uuid:1234</dc:identifier>
       </metadata>
       <manifest>
         <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
         <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
         <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
       </manifest>
       <spine>
         <itemref idref="c1"/>
         <itemref idref="c2"/>
       </spine>
     </package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<html><body><nav epub:type="toc"><ol>
       <li><a href="ch1.xhtml">Beginning</a></li>
       <li><a href="ch2.xhtml">Ending</a></li>
     </ol></nav></body></html>`,
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    `<html><head><title>ignored</title><script>alert('bad')</script></head>
     <body><h1>Beginning</h1><p>Attention is the taking possession of the mind.</p>
     <p onclick="evil()">It implies withdrawal from some things.</p></body></html>`,
  );
  zip.file(
    'OEBPS/ch2.xhtml',
    `<html><body><h1>Ending</h1><p>Several things do not interest me at once.</p></body></html>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

describe('EPUB extraction', () => {
  it('reads metadata, spine order and TOC titles', async () => {
    const book = await parseEpub(await buildEpub());
    expect(book.title).toBe('The Test Book');
    expect(book.author).toBe('Ada Lovelace');
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe('Beginning');
    expect(book.chapters[1].title).toBe('Ending');
    expect(book.chapters[0].text).toContain('Attention is the taking possession');
  });

  it('strips scripts and inline handlers', async () => {
    const book = await parseEpub(await buildEpub());
    expect(book.chapters[0].html).not.toContain('<script');
    expect(book.chapters[0].html).not.toContain('onclick');
    expect(sanitizeHtml('<p onclick="x()">ok</p>')).toBe('<p>ok</p>');
  });

  it('rejects files that are not EPUBs', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'not an epub');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(parseEpub(bytes)).rejects.toThrow(/valid EPUB/);
  });

  it('resolves relative hrefs safely', () => {
    expect(resolveHref('OEBPS/text', '../images/cover.jpg')).toBe('OEBPS/images/cover.jpg');
    expect(resolveHref('', './chapter.xhtml')).toBe('chapter.xhtml');
  });
});
