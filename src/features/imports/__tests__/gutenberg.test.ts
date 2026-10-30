import {
  findGutenbergMarkers,
  stripBoilerplateFromRawHtml,
  stripGutenbergBoilerplate,
} from '@/features/imports/gutenberg';

const BODY = 'It was the best of times, it was the worst of times, it was the age of wisdom.';

function wrap(start: string, end: string, body = BODY): string {
  return `${start}\n\n${body}\n\n${end}`;
}

describe('findGutenbergMarkers', () => {
  it('matches the common start variants', () => {
    const variants = [
      '*** START OF THE PROJECT GUTENBERG EBOOK  ***',
      '***START OF THE PROJECT GUTENBERG EBOOK***',
      '*** START OF THIS PROJECT GUTENBERG EBOOK ULYSSES ***',
      '<!-- *** START OF THE PROJECT GUTENBERG EBOOK ULYSSES *** -->',
    ];
    for (const variant of variants) {
      const markers = findGutenbergMarkers(wrap(variant, '*** END OF THE PROJECT GUTENBERG EBOOK ***'));
      expect(markers.start).not.toBeNull();
      expect(markers.end).not.toBeNull();
      expect(markers.startRaw).toContain('START OF');
    }
  });

  it('matches the common end variants', () => {
    const variants = [
      '*** END OF THE PROJECT GUTENBERG EBOOK  ***',
      'End of the Project Gutenberg E-Book',
      "End of the Project Gutenberg's E-Book",
      '<!-- *** END OF THE PROJECT GUTENBERG EBOOK *** -->',
    ];
    for (const variant of variants) {
      const markers = findGutenbergMarkers(
        wrap('*** START OF THE PROJECT GUTENBERG EBOOK ***', variant),
      );
      expect(markers.end).not.toBeNull();
    }
  });
});

describe('stripGutenbergBoilerplate', () => {
  it('keeps only the body between start and end markers', () => {
    const result = stripGutenbergBoilerplate(
      wrap(
        'The Project Gutenberg eBook of Something\n\n*** START OF THE PROJECT GUTENBERG EBOOK ***',
        '*** END OF THE PROJECT GUTENBERG EBOOK ***\n\nLicence text follows',
      ),
    );
    expect(result.text).toBe(BODY);
    expect(result.start.found).toBe(true);
    expect(result.end.found).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it('handles HTML-comment markers before comments are stripped', () => {
    const raw = wrap(
      '<!-- *** START OF THE PROJECT GUTENBERG EBOOK *** -->',
      '<!-- *** END OF THE PROJECT GUTENBERG EBOOK *** -->',
    );
    const { cut, result } = stripBoilerplateFromRawHtml(raw);
    expect(result.start.found).toBe(true);
    expect(cut).not.toContain('START OF');
    expect(cut).not.toContain('END OF');
    expect(cut).toContain(BODY);
  });

  it('cuts after a start marker when the end is missing', () => {
    const result = stripGutenbergBoilerplate(
      `*** START OF THE PROJECT GUTENBERG EBOOK ***\n\n${BODY}`,
    );
    expect(result.text).toBe(BODY);
    expect(result.end.found).toBe(false);
    expect(result.warnings).toContain('no_end_marker');
  });

  it('keeps text before an end marker when the start is missing', () => {
    const result = stripGutenbergBoilerplate(
      `${BODY}\n\n*** END OF THE PROJECT GUTENBERG EBOOK ***`,
    );
    expect(result.text).toBe(BODY);
    expect(result.start.found).toBe(false);
    expect(result.warnings).toContain('no_start_marker');
  });

  it('returns marker-less text unchanged', () => {
    const text = `${BODY}\n\nMore prose without any licence markers at all.`;
    const result = stripGutenbergBoilerplate(text);
    expect(result.text).toBe(text);
    expect(result.warnings).toContain('no_licence_markers');
    expect(result.removedChars).toBe(0);
  });

  it('treats end-before-start as spurious for a long source', () => {
    const longBody = BODY.repeat(60);
    const text = `*** END OF THE PROJECT GUTENBERG EBOOK ***\n${longBody}\n*** START OF THE PROJECT GUTENBERG EBOOK ***`;
    const result = stripGutenbergBoilerplate(text);
    expect(result.text).toBe(text);
    expect(result.warnings).toContain('end_before_start');
    expect(result.warnings).toContain('suspicious_cut');
    expect(result.suspiciousCut).toBe(true);
  });

  it('refuses a suspiciously small cut from a long source', () => {
    const longBody = BODY.repeat(60);
    const text = `*** START OF THE PROJECT GUTENBERG EBOOK ***\nHi\n*** END OF THE PROJECT GUTENBERG EBOOK ***\n${longBody}`;
    const result = stripGutenbergBoilerplate(text);
    expect(result.text).toBe(text);
    expect(result.suspiciousCut).toBe(true);
    expect(result.warnings).toContain('suspicious_cut');
  });

  it('removes a Produced by header but not body prose', () => {
    const header = stripGutenbergBoilerplate(`Produced by Someone\n\n${BODY}`);
    expect(header.text.startsWith('Produced by')).toBe(false);
    expect(header.text).toContain(BODY);
    expect(header.producedBy.found).toBe(true);
    expect(header.warnings).toContain('no_licence_markers');
    expect(header.removedChars).toBeLessThan(400);

    const bodyProse = stripGutenbergBoilerplate(
      wrap(
        '*** START OF THE PROJECT GUTENBERG EBOOK ***',
        '*** END OF THE PROJECT GUTENBERG EBOOK ***',
        `Produced by hand in a workshop. ${BODY}`,
      ),
    );
    expect(bodyProse.text).toContain('Produced by hand');
  });

  it('handles CRLF input', () => {
    const text = `*** START OF THE PROJECT GUTENBERG EBOOK ***\r\n\r\n${BODY}\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK ***`;
    const result = stripGutenbergBoilerplate(text);
    expect(result.text).toBe(BODY);
  });

  it('uses footer-only fallbacks near the end of the file', () => {
    const result = stripGutenbergBoilerplate(`${BODY}\n\nTHE END`);
    expect(result.text).toBe(BODY);
    expect(result.warnings).toContain('no_start_marker');
  });
});
