/** Deterministic fixtures for the chapter detector. No filesystem or network. */

import type { SectionRef } from '@/features/guides/detect';

export const PSYCHOLOGY_OUTLINE = [
  { title: 'Title Page', page: 1 },
  { title: 'Introduction', page: 7 },
  { title: "1. No One's Crazy", page: 14 },
  { title: '2. Luck & Risk', page: 28 },
  { title: '3. Never Enough', page: 42 },
  { title: '4. Confounding Compounding', page: 52 },
  { title: '5. Getting Wealthy vs. Staying Wealthy', page: 61 },
  { title: '6. Tails, You Win', page: 76 },
  { title: '7. Freedom', page: 89 },
  { title: '8. Man in the Car Paradox', page: 99 },
  { title: "9. Wealth is What You Don't See", page: 102 },
  { title: '10. Save Money', page: 108 },
  { title: '11. Reasonable > Rational', page: 118 },
  { title: '12. Surprise!', page: 128 },
  { title: '13. Room for Error', page: 143 },
  { title: "14. You'll Change", page: 155 },
  { title: "15. Nothing's Free", page: 163 },
  { title: '16. You & Me', page: 173 },
  { title: '17. The Seduction of Pessimism', page: 183 },
  { title: "18. When You'll Believe Anything", page: 198 },
  { title: '19. All Together Now', page: 213 },
  { title: '20. Confessions', page: 221 },
  { title: 'Postscript: A History of My Own Money', page: 231 },
  { title: 'Endnotes', page: 239 },
  { title: 'Acknowledgements', page: 245 },
  { title: 'Publishing Details', page: 249 },
];

export const PSYCHOLOGY_SECTIONS: SectionRef[] = Array.from({ length: 253 }, (_, index) => ({
  id: `sec-${index + 1}`,
  title: null,
  startPage: index + 1,
  endPage: index + 1,
  wordCount: 100,
}));

const BODY_SENTENCE =
  'This page carries ordinary body prose about saving, compounding and the quiet arithmetic of small decisions over a long lifetime.';

function bodyText(repeats = 8): string {
  return Array.from({ length: repeats }, () => BODY_SENTENCE).join(' ');
}

function pagesFrom(text: (page: number) => string, count: number): { page: number; text: string }[] {
  return Array.from({ length: count }, (_, index) => ({ page: index + 1, text: text(index + 1) }));
}

function sectionsFrom(count: number): SectionRef[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `sec-${index + 1}`,
    title: null,
    startPage: index + 1,
    endPage: index + 1,
    wordCount: 100,
  }));
}

const TOC_TITLES = [
  'Chapter One',
  'Chapter Two',
  'Chapter Three',
  'Chapter Four',
  'Chapter Five',
  'Chapter Six',
  'Chapter Seven',
  'Chapter Eight',
];
const TOC_PRINTED_PAGES = [10, 16, 22, 28, 34, 40, 46, 52];

export const PDF_TOC_FIXTURE = {
  pages: pagesFrom((page) => {
    if (page === 1) return 'Cover';
    if (page === 2) return 'Title Page';
    if (page === 3) {
      return TOC_TITLES.slice(0, 4)
        .map((title, index) => `${title} ${'.'.repeat(6)} ${TOC_PRINTED_PAGES[index]}`)
        .join('\n');
    }
    if (page === 4) {
      return TOC_TITLES.slice(4)
        .map((title, index) => `${title} ${'.'.repeat(6)} ${TOC_PRINTED_PAGES[index + 4]}`)
        .join('\n');
    }
    const printedIndex = TOC_PRINTED_PAGES.indexOf(page);
    if (printedIndex >= 0) return `${TOC_TITLES[printedIndex]}\n\n${bodyText(2)}`;
    return bodyText(8);
  }, 60),
  sections: sectionsFrom(60),
};

const HEADING_PAGES = [5, 15, 25, 35, 45];
const HEADING_TITLES = ['Chapter One', 'Chapter Two', 'Chapter Three', 'Chapter Four', 'Chapter Five'];

export const PDF_HEADINGS_FIXTURE = {
  pages: pagesFrom((page) => {
    const headingIndex = HEADING_PAGES.indexOf(page);
    if (headingIndex >= 0) return `${HEADING_TITLES[headingIndex]}\n\nA short opening note.`;
    return bodyText(8);
  }, 50),
  sections: sectionsFrom(50),
};

export const PDF_EQUAL_FIXTURE = {
  pages: pagesFrom(() => bodyText(8), 70),
  sections: sectionsFrom(70),
};

export const ONE_CHAPTER_TEXT: SectionRef[] = [
  {
    id: 'sec-1',
    title: 'Notes',
    startPage: null,
    endPage: null,
    wordCount: 4_000,
  },
];

export const EPUB_THREE: SectionRef[] = [
  { id: 'sec-1', title: 'One', startPage: null, endPage: null, wordCount: 2_000 },
  { id: 'sec-2', title: null, startPage: null, endPage: null, wordCount: 1_500 },
  { id: 'sec-3', title: 'Three', startPage: null, endPage: null, wordCount: 1_000 },
];
