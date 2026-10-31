/** @jest-environment node */
import {
  detectChapters,
  mergeDetected,
  splitDetected,
  stripChapterNumber,
} from '@/features/guides/detect';
import {
  EPUB_THREE,
  ONE_CHAPTER_TEXT,
  PDF_EQUAL_FIXTURE,
  PDF_HEADINGS_FIXTURE,
  PDF_TOC_FIXTURE,
  PSYCHOLOGY_OUTLINE,
  PSYCHOLOGY_SECTIONS,
} from './fixtures';

const PSYCHOLOGY_PAGES = [
  [14, 27],
  [28, 41],
  [42, 51],
  [52, 60],
  [61, 75],
  [76, 88],
  [89, 98],
  [99, 101],
  [102, 107],
  [108, 117],
  [118, 127],
  [128, 142],
  [143, 154],
  [155, 162],
  [163, 172],
  [173, 182],
  [183, 197],
  [198, 212],
  [213, 220],
  [221, 230],
];

describe('PDF outline detection', () => {
  it('returns the 20 verified chapters from the bundled-PDF outline fixture', () => {
    const chapters = detectChapters({
      kind: 'pdf',
      pages: [],
      sections: PSYCHOLOGY_SECTIONS,
      outline: PSYCHOLOGY_OUTLINE,
    });

    expect(chapters).toHaveLength(20);
    expect(chapters[0].title).toBe("1. No One's Crazy");
    expect(chapters[19].title).toBe('20. Confessions');
    expect(chapters.map((chapter) => [chapter.startPage, chapter.endPage])).toEqual(
      PSYCHOLOGY_PAGES,
    );
    expect(chapters.every((chapter) => chapter.source === 'outline')).toBe(true);
    expect(chapters.every((chapter) => chapter.confidence === 'high')).toBe(true);
    expect(chapters.map((chapter) => chapter.ordinal)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(chapters.some((chapter) => /postscript/i.test(chapter.title))).toBe(false);
    expect(chapters.some((chapter) => /endnotes|acknowledg|publishing/i.test(chapter.title))).toBe(
      false,
    );
    expect(chapters[19].sectionIds).toEqual(
      Array.from({ length: 10 }, (_, index) => `sec-${221 + index}`),
    );
  });

  it('keeps the first title on duplicate pages and drops out-of-range entries', () => {
    const chapters = detectChapters({
      kind: 'pdf',
      pages: [],
      sections: PSYCHOLOGY_SECTIONS,
      outline: [
        { title: '1. First', page: 14 },
        { title: '1. Duplicate', page: 14 },
        { title: '2. Second', page: 20 },
        { title: '3. Third', page: 30 },
        { title: '4. Out of range', page: 999 },
      ],
    });
    expect(chapters).toHaveLength(3);
    expect(chapters[0].title).toBe('1. First');
    expect(chapters[0].startPage).toBe(14);
    expect(chapters[0].endPage).toBe(19);
  });
});

describe('PDF TOC detection', () => {
  it('collects a TOC split across two pages and resolves printed page numbers', () => {
    const chapters = detectChapters({
      kind: 'pdf',
      pages: PDF_TOC_FIXTURE.pages,
      sections: PDF_TOC_FIXTURE.sections,
      outline: null,
    });

    expect(chapters).toHaveLength(8);
    expect(chapters.map((chapter) => [chapter.startPage, chapter.endPage])).toEqual([
      [10, 15],
      [16, 21],
      [22, 27],
      [28, 33],
      [34, 39],
      [40, 45],
      [46, 51],
      [52, 60],
    ]);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'Chapter One',
      'Chapter Two',
      'Chapter Three',
      'Chapter Four',
      'Chapter Five',
      'Chapter Six',
      'Chapter Seven',
      'Chapter Eight',
    ]);
    expect(chapters.every((chapter) => chapter.source === 'toc')).toBe(true);
    expect(chapters.every((chapter) => chapter.confidence === 'medium')).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const first = detectChapters({
      kind: 'pdf',
      pages: PDF_TOC_FIXTURE.pages,
      sections: PDF_TOC_FIXTURE.sections,
      outline: null,
    });
    const second = detectChapters({
      kind: 'pdf',
      pages: PDF_TOC_FIXTURE.pages,
      sections: PDF_TOC_FIXTURE.sections,
      outline: null,
    });
    expect(second).toEqual(first);
  });
});

describe('PDF heading and equal fallbacks', () => {
  it('finds heading pages when there is no outline or TOC', () => {
    const chapters = detectChapters({
      kind: 'pdf',
      pages: PDF_HEADINGS_FIXTURE.pages,
      sections: PDF_HEADINGS_FIXTURE.sections,
      outline: null,
    });

    expect(chapters).toHaveLength(5);
    expect(chapters.map((chapter) => [chapter.startPage, chapter.endPage])).toEqual([
      [5, 14],
      [15, 24],
      [25, 34],
      [35, 44],
      [45, 50],
    ]);
    expect(chapters.every((chapter) => chapter.source === 'headings')).toBe(true);
    expect(chapters.every((chapter) => chapter.confidence === 'medium')).toBe(true);
  });

  it('falls back to balanced equal page groups', () => {
    const chapters = detectChapters({
      kind: 'pdf',
      pages: PDF_EQUAL_FIXTURE.pages,
      sections: PDF_EQUAL_FIXTURE.sections,
      outline: null,
      expectedChapters: 7,
    });

    expect(chapters).toHaveLength(7);
    expect(chapters.map((chapter) => [chapter.startPage, chapter.endPage])).toEqual([
      [1, 10],
      [11, 20],
      [21, 30],
      [31, 40],
      [41, 50],
      [51, 60],
      [61, 70],
    ]);
    expect(chapters.map((chapter) => chapter.title)).toEqual(
      Array.from({ length: 7 }, (_, index) => `Part ${index + 1}`),
    );
    expect(chapters.every((chapter) => chapter.source === 'equal')).toBe(true);
    expect(chapters.every((chapter) => chapter.confidence === 'low')).toBe(true);
  });
});

describe('EPUB and text detection', () => {
  it('returns one high-confidence chapter for a one-section text document', () => {
    const chapters = detectChapters({ kind: 'text', sections: ONE_CHAPTER_TEXT });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].source).toBe('single');
    expect(chapters[0].confidence).toBe('high');
    expect(chapters[0].title).toBe('Notes');
    expect(chapters[0].sectionIds).toEqual(['sec-1']);
  });

  it('returns one chapter per EPUB section with dense ordinals and a fallback title', () => {
    const chapters = detectChapters({ kind: 'epub', sections: EPUB_THREE });
    expect(chapters).toHaveLength(3);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['One', 'Chapter 2', 'Three']);
    expect(chapters.map((chapter) => chapter.ordinal)).toEqual([0, 1, 2]);
    expect(chapters.every((chapter) => chapter.source === 'epub')).toBe(true);
  });
});

describe('review helpers', () => {
  it('merge then split round-trips section ids and re-denses ordinals', () => {
    const chapters = detectChapters({ kind: 'epub', sections: EPUB_THREE });
    const merged = mergeDetected(chapters, 0);
    expect(merged).toHaveLength(2);
    expect(merged[0].sectionIds).toEqual(['sec-1', 'sec-2']);
    expect(merged[0].wordCount).toBe(3_500);
    expect(merged[0].source).toBe('manual');
    expect(merged.map((chapter) => chapter.ordinal)).toEqual([0, 1]);

    const split = splitDetected(merged, 0, 'sec-2', EPUB_THREE);
    expect(split).toHaveLength(3);
    expect(split[0].sectionIds).toEqual(['sec-1']);
    expect(split[1].sectionIds).toEqual(['sec-2']);
    expect(split.map((chapter) => chapter.ordinal)).toEqual([0, 1, 2]);
    expect(split[1].wordCount).toBe(1_500);
  });

  it('merge is a no-op on the last chapter and split rejects a bad boundary', () => {
    const chapters = detectChapters({ kind: 'epub', sections: EPUB_THREE });
    expect(mergeDetected(chapters, 2)).toBe(chapters);
    expect(() => splitDetected(chapters, 0, 'sec-1', EPUB_THREE)).toThrow(
      'Cannot split at that section boundary.',
    );
  });

  it('strips a leading chapter number for display only', () => {
    expect(stripChapterNumber("1. No One's Crazy")).toBe("No One's Crazy");
    expect(stripChapterNumber('12) Confessions')).toBe('Confessions');
    expect(stripChapterNumber('Chapter 7: Freedom')).toBe('Freedom');
    expect(stripChapterNumber('Part One')).toBe('Part One');
  });
});
