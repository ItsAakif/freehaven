/**
 * Chapter detection for the Full Guide.
 *
 * Pure and deterministic: no Expo, React or SQLite imports. PDF detection tries
 * the native outline first, then the TOC page, then heading pages and finally
 * balanced equal-page groups.
 */

export type SectionRef = {
  id: string;
  title: string | null;
  startPage: number | null;
  endPage: number | null;
  wordCount: number;
};

export type DetectedChapter = {
  ordinal: number;
  title: string;
  startPage: number | null;
  endPage: number | null;
  sectionIds: string[];
  wordCount: number;
  source: 'epub' | 'outline' | 'toc' | 'headings' | 'equal' | 'single' | 'manual';
  confidence: 'high' | 'medium' | 'low';
};

export type DetectInput =
  | { kind: 'epub'; sections: SectionRef[] }
  | { kind: 'text'; sections: SectionRef[] }
  | {
      kind: 'pdf';
      pages: { page: number; text: string }[];
      sections: SectionRef[];
      outline: { title: string; page: number }[] | null;
      /** Default 20. Used only by the equal-page fallback, never to cap an outline. */
      expectedChapters?: number;
    };

const FRONT_BACK_MATTER =
  /^(cover|title page|copyright|contents|table of contents|dedication|epigraph|foreword|preface|introduction|prologue|endnotes|notes|bibliography|acknowledg|publishing details|index|about the author|postscript|afterword|appendix)\b/i;

const TOC_WITH_PAGE = /^(.{2,90}?)\s*(?:\.{2,}|·{2,}|\s{3,})\s*(\d{1,4})\s*$/;
const TOC_WITHOUT_PAGE = /^\s*(?:\d{1,3}[.)]\s+|chapter\s+\w+\s*[:.]?\s*)(.{2,90})$/i;

const LOWERCASE_CONNECTORS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'or',
  'over',
  'the',
  'to',
  'up',
  'with',
  'vs',
  'vs.',
]);

function words(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}

/** Display helper: strip a leading `12.` / `12)` / `Chapter 12:` prefix. */
export function stripChapterNumber(title: string): string {
  return title.replace(/^\s*(?:chapter\s+)?\d{1,3}\s*[.):\-–—]\s+/i, '').trim();
}

function normaliseTitle(title: string): string {
  return stripChapterNumber(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNumberedTitle(title: string): boolean {
  return (
    /^\s*(?:chapter\s+)?(?:\d{1,3}|[ivxlcdm]{1,7})\s*[.):\-–—]\s*\S/i.test(title) ||
    /^\s*chapter\s+(?:\d+|[a-z]+)\b/i.test(title)
  );
}

function isTitleCase(line: string): boolean {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part, index) => {
    const core = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!core) return false;
    if (index > 0 && LOWERCASE_CONNECTORS.has(core.toLowerCase())) return true;
    return /^[A-Z]/.test(core);
  });
}

function dense(chapters: Omit<DetectedChapter, 'ordinal'>[]): DetectedChapter[] {
  return chapters.map((chapter, ordinal) => ({ ...chapter, ordinal }));
}

function withoutOrdinal(chapter: DetectedChapter): Omit<DetectedChapter, 'ordinal'> {
  return {
    title: chapter.title,
    startPage: chapter.startPage,
    endPage: chapter.endPage,
    sectionIds: chapter.sectionIds,
    wordCount: chapter.wordCount,
    source: chapter.source,
    confidence: chapter.confidence,
  };
}

function sectionRange(
  sections: SectionRef[],
  startPage: number,
  endPage: number,
): { sectionIds: string[]; wordCount: number } {
  const sectionIds: string[] = [];
  let wordCount = 0;
  for (const section of sections) {
    const start = section.startPage ?? section.endPage;
    const end = section.endPage ?? section.startPage;
    if (start == null || end == null) continue;
    if (end >= startPage && start <= endPage) {
      sectionIds.push(section.id);
      wordCount += section.wordCount;
    }
  }
  return { sectionIds, wordCount };
}

/* ------------------------------------------------------------ EPUB / text */

function detectEpubLike(
  kind: 'epub' | 'text',
  inputSections: SectionRef[],
): DetectedChapter[] {
  const sections = inputSections.filter((section) => section.wordCount >= 5);
  if (!sections.length) return [];
  if (kind === 'text' && sections.length === 1) {
    const section = sections[0];
    return [
      {
        ordinal: 0,
        title: section.title?.trim() || 'Chapter 1',
        startPage: section.startPage,
        endPage: section.endPage,
        sectionIds: [section.id],
        wordCount: section.wordCount,
        source: 'single',
        confidence: 'high',
      },
    ];
  }
  return dense(
    sections.map((section, index) => ({
      title: section.title?.trim() || `Chapter ${index + 1}`,
      startPage: section.startPage,
      endPage: section.endPage,
      sectionIds: [section.id],
      wordCount: section.wordCount,
      source: 'epub' as const,
      confidence: 'high' as const,
    })),
  );
}

/* ---------------------------------------------------------------- PDF core */

function pdfPageCount(input: Extract<DetectInput, { kind: 'pdf' }>): number {
  const pagesMax = input.pages.reduce((max, page) => Math.max(max, page.page), 0);
  const sectionsMax = input.sections.reduce(
    (max, section) => Math.max(max, section.endPage ?? section.startPage ?? 0),
    0,
  );
  const known = Math.max(pagesMax, sectionsMax);
  if (known > 0) return known;
  return (input.outline ?? []).reduce(
    (max, entry) => (Number.isFinite(entry.page) ? Math.max(max, entry.page) : max),
    0,
  );
}

function pageText(pages: { page: number; text: string }[], page: number): string {
  return pages.find((candidate) => candidate.page === page)?.text ?? '';
}

type OutlineEntry = { title: string; page: number };

function normaliseOutline(outline: OutlineEntry[] | null, pageCount: number): OutlineEntry[] {
  if (!outline) return [];
  const entries: OutlineEntry[] = [];
  for (const raw of outline) {
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) continue;
    if (!Number.isFinite(raw.page)) continue;
    const page = Math.trunc(raw.page);
    if (page < 1 || page > pageCount) continue;
    entries.push({ title, page });
  }
  entries.sort((left, right) => left.page - right.page);
  const seen = new Set<number>();
  const unique: OutlineEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.page)) continue;
    seen.add(entry.page);
    unique.push(entry);
  }
  return unique;
}

function buildRanges(
  kept: OutlineEntry[],
  all: OutlineEntry[],
  sections: SectionRef[],
  pageCount: number,
  source: 'outline' | 'toc' | 'headings',
  confidence: 'high' | 'medium' | 'low',
): DetectedChapter[] {
  const chapters: Omit<DetectedChapter, 'ordinal'>[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const entry = kept[index];
    const allIndex = all.indexOf(entry);
    const next = allIndex >= 0 ? all[allIndex + 1] : undefined;
    const start = entry.page;
    const end = next
      ? Math.max(start, Math.min(next.page - 1, pageCount))
      : pageCount;
    const range = sectionRange(sections, start, end);
    if (!range.sectionIds.length) continue;
    chapters.push({
      title: entry.title,
      startPage: start,
      endPage: end,
      sectionIds: range.sectionIds,
      wordCount: range.wordCount,
      source,
      confidence,
    });
  }
  return dense(chapters);
}

function chaptersFromOutline(
  entries: OutlineEntry[],
  sections: SectionRef[],
  pageCount: number,
): DetectedChapter[] {
  if (!entries.length) return [];
  const numbered = entries.filter((entry) => isNumberedTitle(entry.title));
  if (numbered.length >= 3) {
    return buildRanges(numbered, entries, sections, pageCount, 'outline', 'high');
  }
  const chapterTitles = entries.filter((entry) => /^\s*chapter\b/i.test(entry.title));
  if (chapterTitles.length >= 3) {
    return buildRanges(chapterTitles, entries, sections, pageCount, 'outline', 'high');
  }
  const kept = entries.filter((entry) => !FRONT_BACK_MATTER.test(entry.title));
  return buildRanges(kept, entries, sections, pageCount, 'outline', 'high');
}

/* ---------------------------------------------------------------- PDF TOC */

type TocEntry = { title: string; printedPage: number | null };

function parseTocLines(text: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const withPage = TOC_WITH_PAGE.exec(line);
    if (withPage) {
      const title = withPage[1].trim();
      if (title.length >= 2) entries.push({ title, printedPage: Number(withPage[2]) });
      continue;
    }
    const withoutPage = TOC_WITHOUT_PAGE.exec(line);
    if (withoutPage) {
      const title = withoutPage[1].trim();
      if (title.length >= 2) entries.push({ title, printedPage: null });
    }
  }
  return entries;
}

function pageOwnPrintedNumber(text: string): number | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of [lines[lines.length - 1], lines[0]]) {
    if (line && /^\d{1,4}$/.test(line)) return Number(line);
  }
  return null;
}

function findToc(
  pages: { page: number; text: string }[],
  pageCount: number,
): { entries: TocEntry[]; tocStart: number; tocEnd: number } | null {
  for (let page = 1; page <= Math.min(15, pageCount); page += 1) {
    const entries = parseTocLines(pageText(pages, page));
    if (entries.length < 3) continue;

    let tocEnd = page;
    for (let extra = 1; extra <= 2; extra += 1) {
      const nextPage = page + extra;
      if (nextPage > pageCount) break;
      const nextEntries = parseTocLines(pageText(pages, nextPage));
      if (!nextEntries.length) break;
      entries.push(...nextEntries);
      tocEnd = nextPage;
    }
    return { entries, tocStart: page, tocEnd };
  }
  return null;
}

function chaptersFromToc(
  toc: { entries: TocEntry[]; tocStart: number; tocEnd: number },
  pages: { page: number; text: string }[],
  sections: SectionRef[],
  pageCount: number,
): DetectedChapter[] {
  const own = pageOwnPrintedNumber(pageText(pages, toc.tocStart));
  const offset = own != null ? own - toc.tocStart : 0;
  const resolved: OutlineEntry[] = [];

  for (const entry of toc.entries) {
    if (entry.printedPage == null) continue;
    const page = entry.printedPage - offset;
    if (page >= 1 && page <= pageCount) resolved.push({ title: entry.title, page });
  }

  const unnumbered = toc.entries.filter((entry) => entry.printedPage == null);
  for (const entry of unnumbered) {
    const needle = normaliseTitle(entry.title);
    if (!needle) continue;
    for (let page = toc.tocEnd + 1; page <= pageCount; page += 1) {
      const head = normaliseTitle(pageText(pages, page).slice(0, 160));
      if (head.includes(needle)) {
        resolved.push({ title: entry.title, page });
        break;
      }
    }
  }

  if (resolved.length < 3) return [];
  resolved.sort((left, right) => left.page - right.page);
  const seen = new Set<number>();
  const unique: OutlineEntry[] = [];
  for (const entry of resolved) {
    if (seen.has(entry.page)) continue;
    seen.add(entry.page);
    unique.push(entry);
  }
  return buildRanges(unique, unique, sections, pageCount, 'toc', 'medium');
}

/* ----------------------------------------------------------- PDF headings */

function chaptersFromHeadings(
  pages: { page: number; text: string }[],
  pageCount: number,
  sections: SectionRef[],
  afterPage: number | null,
): DetectedChapter[] {
  const startPage = afterPage != null ? afterPage + 1 : 1;
  const headingPages: OutlineEntry[] = [];

  for (let page = startPage; page <= pageCount; page += 1) {
    const text = pageText(pages, page);
    const firstLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) continue;
    if (FRONT_BACK_MATTER.test(firstLine)) continue;
    if (firstLine.length < 2 || firstLine.length > 80) continue;
    if (!isNumberedTitle(firstLine) && !isTitleCase(firstLine)) continue;
    if (words(text) >= 80) continue;
    headingPages.push({ title: firstLine, page });
  }

  if (headingPages.length < 3) return [];

  const merged: OutlineEntry[] = [];
  for (const entry of headingPages) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      entry.page === previous.page + 1 &&
      normaliseTitle(entry.title) === normaliseTitle(previous.title)
    ) {
      continue;
    }
    merged.push(entry);
  }
  if (merged.length < 3) return [];
  return buildRanges(merged, merged, sections, pageCount, 'headings', 'medium');
}

/* ------------------------------------------------------------ PDF equal */

function defaultEqualCount(pageCount: number): number {
  return Math.max(1, Math.min(20, Math.round(pageCount / 12)));
}

function equalChapters(
  expectedChapters: number | undefined,
  pageCount: number,
  sections: SectionRef[],
): DetectedChapter[] {
  if (pageCount <= 0) return [];
  const desired = expectedChapters ?? defaultEqualCount(pageCount);
  const count = Math.max(1, Math.min(desired, Math.min(40, pageCount)));
  const base = Math.floor(pageCount / count);
  const remainder = pageCount % count;

  const chapters: Omit<DetectedChapter, 'ordinal'>[] = [];
  let cursor = 1;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    const start = cursor;
    const end = cursor + size - 1;
    cursor = end + 1;
    const range = sectionRange(sections, start, end);
    chapters.push({
      title: `Part ${index + 1}`,
      startPage: start,
      endPage: end,
      sectionIds: range.sectionIds,
      wordCount: range.wordCount,
      source: 'equal',
      confidence: 'low',
    });
  }
  return dense(chapters);
}

/* ---------------------------------------------------------------- entry */

function detectPdf(input: Extract<DetectInput, { kind: 'pdf' }>): DetectedChapter[] {
  const pageCount = pdfPageCount(input);
  if (pageCount <= 0) return [];

  const outline = normaliseOutline(input.outline, pageCount);
  const fromOutline = chaptersFromOutline(outline, input.sections, pageCount);
  if (fromOutline.length) return fromOutline;

  const toc = findToc(input.pages, pageCount);
  if (toc) {
    const fromToc = chaptersFromToc(toc, input.pages, input.sections, pageCount);
    if (fromToc.length) return fromToc;
  }

  const fromHeadings = chaptersFromHeadings(
    input.pages,
    pageCount,
    input.sections,
    toc?.tocEnd ?? null,
  );
  if (fromHeadings.length) return fromHeadings;

  return equalChapters(input.expectedChapters, pageCount, input.sections);
}

export function detectChapters(input: DetectInput): DetectedChapter[] {
  if (input.kind === 'pdf') return detectPdf(input);
  return detectEpubLike(input.kind, input.sections);
}

/* ------------------------------------------------------- review operations */

/** Merge `chapters[index]` with the next; no-op when it is the last chapter. */
export function mergeDetected(
  chapters: DetectedChapter[],
  index: number,
): DetectedChapter[] {
  if (index < 0 || index >= chapters.length - 1) return chapters;
  const first = chapters[index];
  const second = chapters[index + 1];
  const sectionIds: string[] = [];
  for (const id of [...first.sectionIds, ...second.sectionIds]) {
    if (!sectionIds.includes(id)) sectionIds.push(id);
  }
  const merged: DetectedChapter = {
    ordinal: index,
    title: `${first.title} / ${second.title}`,
    startPage: first.startPage ?? second.startPage,
    endPage: second.endPage ?? first.endPage,
    sectionIds,
    wordCount: first.wordCount + second.wordCount,
    source: 'manual',
    confidence: 'medium',
  };
  return dense([
    ...chapters.slice(0, index).map(withoutOrdinal),
    withoutOrdinal(merged),
    ...chapters.slice(index + 2).map(withoutOrdinal),
  ]);
}

function pagesFor(
  sectionIds: string[],
  sections: SectionRef[],
): { startPage: number | null; endPage: number | null; wordCount: number } {
  let startPage: number | null = null;
  let endPage: number | null = null;
  let wordCount = 0;
  for (const id of sectionIds) {
    const section = sections.find((candidate) => candidate.id === id);
    if (!section) continue;
    wordCount += section.wordCount;
    if (section.startPage != null) {
      startPage = startPage == null ? section.startPage : Math.min(startPage, section.startPage);
    }
    if (section.endPage != null) {
      endPage = endPage == null ? section.endPage : Math.max(endPage, section.endPage);
    }
  }
  return { startPage, endPage, wordCount };
}

/** Split before `atSectionId`; requires a boundary inside the chapter. */
export function splitDetected(
  chapters: DetectedChapter[],
  index: number,
  atSectionId: string,
  sections: SectionRef[],
): DetectedChapter[] {
  const chapter = chapters[index];
  if (!chapter) return chapters;
  const cut = chapter.sectionIds.indexOf(atSectionId);
  if (cut < 1 || cut >= chapter.sectionIds.length) {
    throw new Error('Cannot split at that section boundary.');
  }

  const firstIds = chapter.sectionIds.slice(0, cut);
  const secondIds = chapter.sectionIds.slice(cut);
  const firstRange = pagesFor(firstIds, sections);
  const secondRange = pagesFor(secondIds, sections);

  const first: DetectedChapter = {
    ordinal: index,
    title: `${chapter.title} (1)`,
    startPage: firstRange.startPage ?? chapter.startPage,
    endPage: firstRange.endPage ?? chapter.endPage,
    sectionIds: firstIds,
    wordCount: firstRange.wordCount,
    source: 'manual',
    confidence: 'medium',
  };
  const second: DetectedChapter = {
    ordinal: index + 1,
    title: `${chapter.title} (2)`,
    startPage: secondRange.startPage ?? chapter.startPage,
    endPage: secondRange.endPage ?? chapter.endPage,
    sectionIds: secondIds,
    wordCount: secondRange.wordCount,
    source: 'manual',
    confidence: 'medium',
  };

  return dense([
    ...chapters.slice(0, index).map(withoutOrdinal),
    withoutOrdinal(first),
    withoutOrdinal(second),
    ...chapters.slice(index + 1).map(withoutOrdinal),
  ]);
}
