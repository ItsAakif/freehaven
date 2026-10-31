/** @jest-environment node */
import { PDFDocument } from 'pdf-lib';
import {
  GUIDE_FOOTER_HEIGHT,
  GUIDE_MARGIN,
  GUIDE_PAGE_HEIGHT,
  GUIDE_PAGE_WIDTH,
  layoutGuidePages,
} from '@/features/export/guidePdf';
import {
  buildFullGuidePdf,
  fullGuideContent,
  type FullGuidePdfInput,
} from '@/features/export/fullGuidePdf';
import type { Guide, GuideChapter } from '@/domain/guides';

const measure = (text: string, size: number, _bold?: boolean) => text.length * size * 0.5;

function fakeGuide(): Guide {
  return {
    id: 'gd-1',
    bookId: 'book-1',
    planId: null,
    title: 'The Psychology of Money',
    styleId: 'fireside',
    language: 'en',
    engine: 'device',
    voice: null,
    model: null,
    wordsPerChapter: 250,
    chaptersPerDay: 1,
    status: 'generated',
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function fakeChapter(ordinal: number): GuideChapter {
  return {
    id: `gc-${ordinal}`,
    guideId: 'gd-1',
    ordinal,
    title: `${ordinal + 1}. Chapter ${ordinal + 1}`,
    startPage: ordinal + 1,
    endPage: ordinal + 1,
    sectionIds: [`sec-${ordinal + 1}`],
    summaryMd: [
      `The opening line for chapter ${ordinal + 1}.`,
      '',
      '> Compounding rewards patience and punishes interruption.',
      '',
      'Words about money, behaviour and the long view. '.repeat(10),
    ].join('\n'),
    wordCount: 70,
    provider: 'device',
    model: null,
    status: 'ready',
    error: null,
    audioPath: null,
    durationMs: 120_000,
    timingsJson: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const input: FullGuidePdfInput = {
  guide: fakeGuide(),
  bookTitle: 'The Psychology of Money',
  author: 'Morgan Housel',
  chapters: Array.from({ length: 20 }, (_, index) => fakeChapter(index)),
};

describe('full guide PDF', () => {
  it('lays out one chapter per topic with a heading on each chapter page', () => {
    const content = fullGuideContent(input);
    expect(content.topics).toHaveLength(20);
    expect(content.intro[0]?.text).toContain('20 chapters');

    const pages = layoutGuidePages({
      id: 'full-gd-1',
      bookTitle: input.bookTitle,
      subtitle: 'Full guide',
      intro: content.intro,
      topics: content.topics,
      pageWidth: GUIDE_PAGE_WIDTH,
      pageHeight: GUIDE_PAGE_HEIGHT,
      margin: GUIDE_MARGIN,
      footerHeight: GUIDE_FOOTER_HEIGHT,
      pageBreakPerTopic: true,
      measureText: measure,
    });

    const headings = pages.flatMap((page) =>
      page.lines.filter((line) => line.role === 'heading').map((line) => line.text),
    );
    expect(headings).toEqual(
      input.chapters.map((chapter) => `${chapter.ordinal + 1}. Chapter ${chapter.ordinal + 1}`),
    );

    const headingPages = pages.filter((page) =>
      page.lines.some((line) => line.role === 'heading'),
    );
    expect(headingPages).toHaveLength(20);
    for (const page of headingPages.slice(1)) {
      expect(page.lines[0].role).toBe('heading');
    }
  });

  it('renders a branded PDF whose page count covers every chapter', async () => {
    const bytes = await buildFullGuidePdf(input, { logoBytes: null });
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getTitle()).toBe('The Psychology of Money');
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(20);
  });
});
