import { buildExtraction, detectFormat } from '@/features/imports/service';

describe('import extraction builder', () => {
  it('detects supported formats and rejects others', () => {
    expect(detectFormat('book.epub')).toBe('epub');
    expect(detectFormat('paper.PDF')).toBe('pdf');
    expect(detectFormat('notes.txt')).toBe('text');
    expect(detectFormat('photo.jpg', 'image/jpeg')).toBeNull();
  });

  it('builds ordered sections and non-empty chunks for an EPUB', () => {
    const result = buildExtraction('epub', {
      kind: 'epub',
      chapters: [
        { title: 'One', href: 'c1.xhtml', html: '<p>One</p>', text: 'First chapter body. '.repeat(40) },
        { title: 'Two', href: 'c2.xhtml', html: '<p>Two</p>', text: 'Second chapter body. '.repeat(40) },
      ],
    });
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].text).toContain('First chapter');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].sectionId).toBe(result.sections[0].id);
    expect(result.words).toBeGreaterThan(100);
    const offsets = result.chunks.map((c) => c.charStart ?? 0);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('creates one section per PDF page and keeps page numbers on chunks', () => {
    const result = buildExtraction('pdf', {
      kind: 'pdf',
      pages: [
        { page: 1, text: 'Page one text about habits and cues.' },
        { page: 2, text: 'Page two text about rewards and routines.' },
      ],
    });
    expect(result.sections).toHaveLength(2);
    expect(result.sections[1].startPage).toBe(2);
    expect(result.chunks.every((c) => c.page === 1 || c.page === 2)).toBe(true);
  });

  it('handles plain text input', () => {
    const result = buildExtraction('text', { kind: 'text', text: 'A short note about learning.', title: 'Note' });
    expect(result.sections).toHaveLength(1);
    expect(result.chunks[0].text).toContain('short note');
  });
});
