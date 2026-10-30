import { htmlMeta, htmlTitle, htmlToText } from '@/features/imports/html';

describe('htmlToText', () => {
  it('removes page furniture, scripts, styles and comments', () => {
    const html = `
      <html><head><title>Ignored</title><style>.x{color:red}</style></head>
      <body>
        <nav><a href="/">Home</a></nav>
        <header>Site header</header>
        <!-- a comment -->
        <script>alert('bad')</script>
        <div class="pgheader">Produced by Someone</div>
        <p>Real body text.</p>
        <footer>Footer text</footer>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).toBe('Real body text.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('Site header');
    expect(text).not.toContain('Footer text');
  });

  it('turns <br> into newlines and paragraphs into blank lines', () => {
    expect(htmlToText('<p>One<br>Two</p><p>Three</p>')).toBe('One\nTwo\n\nThree');
  });

  it('prefixes list items with a bullet', () => {
    expect(htmlToText('<ul><li>Alpha</li><li>Beta</li></ul>')).toBe('• Alpha\n\n• Beta');
  });

  it('preserves preformatted whitespace for poetry', () => {
    const text = htmlToText('<pre>line one\n  indented line\n\nline three</pre>');
    expect(text).toBe('line one\n  indented line\n\nline three');

    const collapsed = htmlToText('<pre>line one\n  indented line</pre>', { preservePre: false });
    expect(collapsed).toBe('line one indented line');
  });

  it('decodes named, decimal and hexadecimal entities', () => {
    const text = htmlToText(
      '&amp; &lt; &gt; &quot; &apos; &nbsp; &mdash; &ndash; &hellip; &lsquo; &rsquo; &ldquo; &rdquo; ' +
        '&copy; &reg; &trade; &deg; &plusmn; &times; &divide; &frac12; &frac14; &frac34; ' +
        '&eacute; &szlig; &euro; &#8212; &#169; &#x1F600;',
    );
    expect(text).toContain('& < > " \'');
    expect(text).toContain('—');
    expect(text).toContain('…');
    expect(text).toContain('“');
    expect(text).toContain('”');
    expect(text).toContain('©');
    expect(text).toContain('½');
    expect(text).toContain('é');
    expect(text).toContain('😀');
  });

  it('leaves an unknown named entity verbatim', () => {
    expect(htmlToText('Hello &notarealentity; world')).toBe('Hello &notarealentity; world');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(htmlToText('   \n\t ')).toBe('');
  });
});

describe('htmlTitle and htmlMeta', () => {
  const html = `<html lang="fr"><head>
    <title> Les Misérables </title>
    <meta charset="windows-1252">
    <meta name="author" content="Victor Hugo">
  </head><body><p>Body</p></body></html>`;

  it('reads the title and metadata', () => {
    expect(htmlTitle(html)).toBe('Les Misérables');
    expect(htmlMeta(html)).toEqual({
      charset: 'windows-1252',
      title: 'Les Misérables',
      author: 'Victor Hugo',
      language: 'fr',
    });
  });

  it('returns nulls when metadata is absent', () => {
    expect(htmlTitle('<p>No title</p>')).toBeNull();
    expect(htmlMeta('<p>No head</p>')).toEqual({
      charset: null,
      title: null,
      author: null,
      language: null,
    });
  });
});
