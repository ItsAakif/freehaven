/** @jest-environment node */
import { PDFDocument } from 'pdf-lib';
import {
  GUIDE_FOOTER_HEIGHT,
  GUIDE_MARGIN,
  GUIDE_PAGE_HEIGHT,
  GUIDE_PAGE_WIDTH,
  buildGuidePdf,
  layoutGuidePages,
  sanitiseForPdf,
  wrapPdfText,
} from '@/features/export/guidePdf';
import { parseGuideScript } from '@/features/narration/guideScript';

const measure = (text: string, size: number, _bold?: boolean) => text.length * size * 0.5;

function guideFrom(markdown: string) {
  const parsed = parseGuideScript(markdown);
  return {
    id: 'rd-test',
    bookTitle: 'The Psychology of Money',
    subtitle: 'Fireside · 15 min',
    intro: parsed.intro,
    topics: parsed.topics,
  };
}

describe('guide script parsing', () => {
  it('splits the intro from numbered topics and keeps quotes', () => {
    const parsed = parseGuideScript(
      [
        'A short opening about the book.',
        '',
        '## Why money behaves oddly',
        'First paragraph.',
        '',
        '> Compounding is the whole game.',
        '',
        '## Room for error',
        '- Keep a margin.',
        '- Expect surprises.',
      ].join('\n'),
    );

    expect(parsed.intro).toEqual([{ kind: 'paragraph', text: 'A short opening about the book.' }]);
    expect(parsed.topics.map((topic) => topic.title)).toEqual([
      'Why money behaves oddly',
      'Room for error',
    ]);
    expect(parsed.topics[0].blocks[1]).toEqual({
      kind: 'quote',
      text: 'Compounding is the whole game.',
    });
    expect(parsed.topics[1].blocks[0].text).toContain('Keep a margin.');
  });

  it('returns nothing for an empty script', () => {
    expect(parseGuideScript('   ')).toEqual({ intro: [], topics: [] });
  });
});

describe('guide PDF pagination', () => {
  it('never places a line outside the printable area', () => {
    const paragraphs = Array.from({ length: 30 }, () =>
      'Compounding rewards patience and punishes interruption, which is why the boring plan usually wins. '.repeat(
        3,
      ),
    ).join('\n\n');
    const input = guideFrom(`Opening line.\n\n## One\n${paragraphs}\n\n## Two\n${paragraphs}`);

    const pages = layoutGuidePages({
      ...input,
      pageWidth: GUIDE_PAGE_WIDTH,
      pageHeight: GUIDE_PAGE_HEIGHT,
      margin: GUIDE_MARGIN,
      footerHeight: GUIDE_FOOTER_HEIGHT,
      measureText: measure,
    });

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.lines.length).toBeGreaterThan(0);
      for (const line of page.lines) {
        expect(line.y).toBeGreaterThanOrEqual(GUIDE_FOOTER_HEIGHT - 0.001);
        expect(line.y + line.size).toBeLessThanOrEqual(GUIDE_PAGE_HEIGHT);
        expect(line.x).toBeGreaterThanOrEqual(GUIDE_MARGIN - 0.001);
        expect(line.x + measure(line.text, line.size, line.bold)).toBeLessThanOrEqual(
          GUIDE_PAGE_WIDTH - GUIDE_MARGIN + 0.5,
        );
      }
    }

    const headings = pages.flatMap((page) =>
      page.lines.filter((line) => line.role === 'heading').map((line) => line.text),
    );
    expect(headings[0]).toBe('1. One');
    expect(headings[1]).toBe('2. Two');
  });

  it('wraps long words and sanitises smart punctuation', () => {
    expect(sanitiseForPdf('“Smart” — dashes…')).toBe('"Smart" - dashes...');
    const wrapped = wrapPdfText('supercalifragilistic', 10, false, 30, measure);
    expect(wrapped.join('')).toBe('supercalifragilistic');
    expect(wrapped.every((line) => measure(line, 10) <= 30)).toBe(true);
  });
});

describe('guide PDF rendering', () => {
  it('renders A4 cream pages with masthead and footers', async () => {
    const input = guideFrom(
      `Opening line.\n\n## One\n${'A useful paragraph about habits and money. '.repeat(40)}\n\n## Two\n${'Another useful paragraph about risk and patience. '.repeat(40)}`,
    );
    const bytes = await buildGuidePdf(input, { logoBytes: null });
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getTitle()).toBe('The Psychology of Money');
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeCloseTo(GUIDE_PAGE_WIDTH, 1);
    expect(page.getHeight()).toBeCloseTo(GUIDE_PAGE_HEIGHT, 1);
  });
});
