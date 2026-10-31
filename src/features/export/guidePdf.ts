/**
 * Guide PDF export.
 *
 * Layout is pure: `layoutGuidePages` only needs a text measurement callback, so
 * pagination can be tested without pdf-lib, a device or the brand asset. The
 * renderer adds the cream paper, teal masthead, logo and footers.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import { File, Paths } from 'expo-file-system';
import { palettes } from '@/design/tokens';
import type { GuideBlock, GuideTopic } from '@/features/narration/guideScript';

export const GUIDE_PAGE_WIDTH = 595.28;
export const GUIDE_PAGE_HEIGHT = 841.89;
export const GUIDE_MARGIN = 54;
export const GUIDE_HEADER_HEIGHT = 210;
export const GUIDE_FOOTER_HEIGHT = 54;

export type GuidePdfInput = {
  id: string;
  bookTitle: string;
  subtitle: string;
  intro: GuideBlock[];
  topics: GuideTopic[];
  generatedAt?: number;
};

export type GuidePdfRole = 'intro' | 'heading' | 'body' | 'quote';

export type GuidePdfLine = {
  text: string;
  x: number;
  y: number;
  size: number;
  lineHeight: number;
  bold: boolean;
  role: GuidePdfRole;
};

export type GuidePdfPage = {
  lines: GuidePdfLine[];
  first: boolean;
};

export type GuidePdfLayoutOptions = GuidePdfInput & {
  pageWidth?: number;
  pageHeight?: number;
  margin?: number;
  headerHeight?: number;
  footerHeight?: number;
  /** Start every topic after the first on a fresh page. Default false. */
  pageBreakPerTopic?: boolean;
  measureText: (text: string, size: number, bold: boolean) => number;
};

/** Replace typographic punctuation and unsupported glyphs with WinAnsi-safe text. */
export function sanitiseForPdf(input: string): string {
  return (input ?? '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u2022\u25E6\u25AA]/g, '-')
    .replace(/[\u2192\u2794]/g, '->')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\xA0-\xFF\n\t]/g, '');
}

/** Greedy word wrap for a PDF font, hard-splitting words that exceed the width. */
export function wrapPdfText(
  text: string,
  size: number,
  bold: boolean,
  maxWidth: number,
  measureText: (text: string, size: number, bold: boolean) => number,
): string[] {
  const clean = sanitiseForPdf(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of clean.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureText(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (measureText(word, size, bold) <= maxWidth) {
      current = word;
      continue;
    }
    let piece = '';
    for (const char of word) {
      const next = piece + char;
      if (piece && measureText(next, size, bold) > maxWidth) {
        lines.push(piece);
        piece = char;
      } else {
        piece = next;
      }
    }
    current = piece;
  }

  if (current) lines.push(current);
  return lines;
}

type EmitOptions = {
  size: number;
  lineHeight: number;
  bold: boolean;
  role: GuidePdfRole;
  indent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
};

/**
 * Paginate the guide. Every returned baseline sits above the footer reserve and
 * below the page top; the renderer can therefore draw lines without clipping.
 */
export function layoutGuidePages(options: GuidePdfLayoutOptions): GuidePdfPage[] {
  const pageWidth = options.pageWidth ?? GUIDE_PAGE_WIDTH;
  const pageHeight = options.pageHeight ?? GUIDE_PAGE_HEIGHT;
  const margin = options.margin ?? GUIDE_MARGIN;
  const headerHeight = options.headerHeight ?? GUIDE_HEADER_HEIGHT;
  const contentBottom = options.footerHeight ?? GUIDE_FOOTER_HEIGHT;
  const contentWidth = pageWidth - margin * 2;
  const firstTop = pageHeight - headerHeight - 12;
  const nextTop = pageHeight - margin;
  const measure = options.measureText;
  const pages: GuidePdfPage[] = [];
  let page: GuidePdfPage | null = null;
  let cursor = 0;

  const newPage = () => {
    page = { lines: [], first: pages.length === 0 };
    pages.push(page);
    cursor = page.first ? firstTop : nextTop;
  };

  newPage();

  const ensure = (height: number) => {
    if (cursor - height < contentBottom) newPage();
  };

  const emitWrapped = (lines: string[], opts: EmitOptions) => {
    if (!lines.length) return;
    const indent = opts.indent ?? 0;
    const spaceBefore = opts.spaceBefore ?? 0;
    const spaceAfter = opts.spaceAfter ?? 0;
    if (spaceBefore > 0) {
      ensure(spaceBefore + opts.lineHeight);
      cursor -= spaceBefore;
    }
    for (const line of lines) {
      ensure(opts.lineHeight);
      cursor -= opts.lineHeight;
      page?.lines.push({
        text: line,
        x: margin + indent,
        y: cursor,
        size: opts.size,
        lineHeight: opts.lineHeight,
        bold: opts.bold,
        role: opts.role,
      });
    }
    if (spaceAfter > 0) cursor -= spaceAfter;
  };

  const emit = (text: string, opts: EmitOptions) => {
    const lines = wrapPdfText(text, opts.size, opts.bold, contentWidth - (opts.indent ?? 0), measure);
    emitWrapped(lines, opts);
  };

  for (const block of options.intro) {
    emit(block.text, {
      size: 12.5,
      lineHeight: 19,
      bold: false,
      role: block.kind === 'quote' ? 'quote' : 'intro',
      indent: block.kind === 'quote' ? 16 : 0,
      spaceAfter: 10,
    });
  }

  options.topics.forEach((topic, index) => {
    if (index > 0 && options.pageBreakPerTopic) {
      if (page && page.lines.length > 0) newPage();
      else cursor = page?.first ? firstTop : nextTop;
    }
    const headingText = `${index + 1}. ${topic.title}`;
    const headingSize = 15;
    const headingLineHeight = 20;
    const headingLines = wrapPdfText(
      headingText,
      headingSize,
      true,
      contentWidth,
      measure,
    );
    const firstBlock = topic.blocks[0];
    const firstBlockLineHeight = firstBlock?.kind === 'quote' ? 17 : 19;

    ensure(18 + headingLines.length * headingLineHeight + 6 + firstBlockLineHeight);
    cursor -= 18;
    emitWrapped(headingLines, {
      size: headingSize,
      lineHeight: headingLineHeight,
      bold: true,
      role: 'heading',
    });
    cursor -= 6;

    for (const block of topic.blocks) {
      const quote = block.kind === 'quote';
      emit(block.text, {
        size: quote ? 11 : 11.5,
        lineHeight: quote ? 17 : 19,
        bold: false,
        role: quote ? 'quote' : 'body',
        indent: quote ? 16 : 0,
        spaceBefore: quote ? 4 : 0,
        spaceAfter: 10,
      });
    }
  });

  return pages;
}

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  );
}

const PAPER = hexToRgb(palettes.light.bgElevated);
const CREAM = hexToRgb(palettes.light.bg);
const TEAL = hexToRgb(palettes.light.accent);
const TEAL_SOFT = hexToRgb(palettes.light.accentSoft);
const INK = hexToRgb(palettes.light.ink);
const MUTED = hexToRgb(palettes.light.inkMuted);
const WHITE = hexToRgb(palettes.light.accentInk);

async function loadBrandLockup(): Promise<Uint8Array | null> {
  try {
    // Lazy requires keep Jest and the Node renderer away from native modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Asset } = require('expo-asset') as typeof import('expo-asset');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File: FsFile } = require('expo-file-system') as typeof import('expo-file-system');
    const candidates = [
      // The opaque app icon is the safest source for pdf-lib; the lockup is a fallback.
      require('../../../assets/images/icon.png'),
      require('../../../assets/images/brand-lockup.png'),
    ];
    for (const source of candidates) {
      try {
        const asset = Asset.fromModule(source);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (!uri) continue;
        const bytes = await new FsFile(uri).bytes();
        if (bytes.length) return bytes;
      } catch {
        // Try the next candidate; a missing asset must not fail the export.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function drawMasthead(
  page: ReturnType<PDFDocument['addPage']>,
  input: GuidePdfInput,
  fonts: { regular: PDFFont; bold: PDFFont },
  measure: (text: string, size: number, bold: boolean) => number,
  logo: PDFImage | null,
) {
  const { width, height } = page.getSize();
  page.drawRectangle({
    x: 0,
    y: height - GUIDE_HEADER_HEIGHT,
    width,
    height: GUIDE_HEADER_HEIGHT,
    color: TEAL,
  });
  page.drawRectangle({
    x: 0,
    y: height - GUIDE_HEADER_HEIGHT - 4,
    width,
    height: 4,
    color: TEAL_SOFT,
  });

  // Always print the wordmark, even when the logo image could not be embedded.
  const wordmark = 'FREEHAVEN';
  const wordmarkSize = 10;
  page.drawText(wordmark, {
    x: width - GUIDE_MARGIN - fonts.bold.widthOfTextAtSize(wordmark, wordmarkSize),
    y: height - GUIDE_MARGIN,
    size: wordmarkSize,
    font: fonts.bold,
    color: WHITE,
  });

  let baseline = height - GUIDE_MARGIN;
  if (logo) {
    const logoHeight = 38;
    const logoWidth = logoHeight * (logo.width / logo.height);
    page.drawImage(logo, {
      x: GUIDE_MARGIN,
      y: baseline - logoHeight,
      width: logoWidth,
      height: logoHeight,
    });
    baseline -= logoHeight + 16;
  } else {
    baseline -= 8;
  }

  const titleLines = wrapPdfText(
    input.bookTitle,
    20,
    true,
    width - GUIDE_MARGIN * 2,
    measure,
  ).slice(0, 3);
  baseline -= 18;
  for (const line of titleLines) {
    page.drawText(line, {
      x: GUIDE_MARGIN,
      y: baseline,
      size: 20,
      font: fonts.bold,
      color: WHITE,
    });
    baseline -= 25;
  }

  page.drawText(sanitiseForPdf(input.subtitle), {
    x: GUIDE_MARGIN,
    y: Math.max(height - GUIDE_HEADER_HEIGHT + 12, baseline),
    size: 10,
    font: fonts.regular,
    color: TEAL_SOFT,
  });
}

/** Render a complete guide PDF in memory. `logoBytes: null` skips the asset. */
export async function buildGuidePdf(
  input: GuidePdfInput,
  options: { logoBytes?: Uint8Array | null; pageBreakPerTopic?: boolean } = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const measure = (text: string, size: number, isBold: boolean) =>
    (isBold ? bold : regular).widthOfTextAtSize(text, size);

  const logoBytes = options.logoBytes === undefined ? await loadBrandLockup() : options.logoBytes;
  let logo: PDFImage | null = null;
  if (logoBytes && logoBytes.length) {
    try {
      logo = await pdf.embedPng(logoBytes);
    } catch {
      logo = null;
    }
  }

  const pages = layoutGuidePages({
    ...input,
    pageWidth: GUIDE_PAGE_WIDTH,
    pageHeight: GUIDE_PAGE_HEIGHT,
    margin: GUIDE_MARGIN,
    headerHeight: GUIDE_HEADER_HEIGHT,
    footerHeight: GUIDE_FOOTER_HEIGHT,
    pageBreakPerTopic: options.pageBreakPerTopic ?? false,
    measureText: measure,
  });

  const generatedAt = new Date(input.generatedAt ?? Date.now());

  pages.forEach((layout, pageIndex) => {
    const page = pdf.addPage([GUIDE_PAGE_WIDTH, GUIDE_PAGE_HEIGHT]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: GUIDE_PAGE_WIDTH,
      height: GUIDE_PAGE_HEIGHT,
      color: PAPER,
    });
    page.drawRectangle({
      x: GUIDE_MARGIN / 2,
      y: GUIDE_MARGIN / 2,
      width: GUIDE_PAGE_WIDTH - GUIDE_MARGIN,
      height: GUIDE_PAGE_HEIGHT - GUIDE_MARGIN,
      borderColor: CREAM,
      borderWidth: 1,
    });

    if (layout.first) {
      drawMasthead(page, input, { regular, bold }, measure, logo);
    }

    for (const line of layout.lines) {
      if (line.role === 'quote') {
        page.drawRectangle({
          x: line.x - 10,
          y: line.y - 2,
          width: 2,
          height: Math.max(2, line.lineHeight - 2),
          color: TEAL_SOFT,
        });
      }
      const color = line.role === 'heading' ? TEAL : line.role === 'quote' ? MUTED : INK;
      page.drawText(line.text, {
        x: line.x,
        y: line.y,
        size: line.size,
        font: line.bold ? bold : regular,
        color,
      });
    }

    page.drawText('Freehaven · generated on this device', {
      x: GUIDE_MARGIN,
      y: 26,
      size: 8,
      font: regular,
      color: MUTED,
    });
    const pageNumber = `${pageIndex + 1} / ${pages.length}`;
    page.drawText(pageNumber, {
      x: GUIDE_PAGE_WIDTH - GUIDE_MARGIN - regular.widthOfTextAtSize(pageNumber, 8),
      y: 26,
      size: 8,
      font: regular,
      color: MUTED,
    });
  });

  pdf.setTitle(sanitiseForPdf(input.bookTitle));
  pdf.setAuthor('Freehaven');
  pdf.setSubject('Freehaven guide');
  pdf.setCreator('Freehaven');
  pdf.setProducer('Freehaven');
  pdf.setCreationDate(generatedAt);

  return pdf.save();
}

/** Build and write `Paths.cache/guide-<id>.pdf`, returning its shareable URI. */
export async function writeGuidePdf(
  input: GuidePdfInput,
  options: { pageBreakPerTopic?: boolean } = {},
): Promise<string> {
  const bytes = await buildGuidePdf(input, options);
  const safeId = input.id.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const file = new File(Paths.cache, `guide-${safeId}.pdf`);
  if (file.exists) file.delete();
  file.create({ intermediates: true, overwrite: true });
  await file.write(bytes);
  return file.uri;
}
