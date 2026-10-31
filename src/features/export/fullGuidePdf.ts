/**
 * Full Guide PDF export.
 *
 * One chapter per topic and a forced page break between chapters. Branding,
 * typography and pagination come from the existing rendition guide renderer.
 */

import { File, Paths } from 'expo-file-system';
import type { Guide, GuideChapter } from '@/domain/guides';
import { wordCount } from '@/domain/text';
import {
  parseGuideScript,
  type GuideBlock,
  type GuideTopic,
} from '@/features/narration/guideScript';
import { stripChapterNumber } from '@/features/guides/detect';
import { buildGuidePdf } from './guidePdf';

export type FullGuidePdfInput = {
  guide: Guide;
  bookTitle: string;
  author: string | null;
  chapters: GuideChapter[];
  generatedAt?: number;
};

export type FullGuideContent = {
  intro: GuideBlock[];
  topics: GuideTopic[];
  words: number;
};

/** Strip Markdown markers from a plain chapter summary for the PDF fallback. */
function strippedParagraph(markdown: string): string {
  return (markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure document content: the intro line plus one topic per chapter that has a
 * summary, in ordinal order. Kept separate from rendering so the layout can be
 * tested without pdf-lib.
 */
export function fullGuideContent(input: FullGuidePdfInput): FullGuideContent {
  const chapters = [...input.chapters]
    .filter((chapter) => !!chapter.summaryMd?.trim())
    .sort((a, b) => a.ordinal - b.ordinal);
  const words = chapters.reduce(
    (total, chapter) =>
      total + (chapter.wordCount || wordCount(chapter.summaryMd ?? '')),
    0,
  );

  const intro: GuideBlock[] = [
    {
      kind: 'paragraph',
      text: `${chapters.length} chapters · one a day · ${words.toLocaleString('en-US')} words of summary`,
    },
  ];

  const topics: GuideTopic[] = chapters.map((chapter) => {
    const summary = chapter.summaryMd ?? '';
    const parsed = parseGuideScript(summary);
    let blocks: GuideBlock[];
    if (parsed.topics.length && parsed.topics[0].blocks.length) {
      blocks = parsed.topics[0].blocks;
    } else if (parsed.intro.length) {
      blocks = parsed.intro;
    } else {
      blocks = [{ kind: 'paragraph', text: strippedParagraph(summary) }];
    }

    // `layoutGuidePages` already prefixes the ordinal, so the stored title is
    // stripped rather than numbered again.
    const cleanTitle = stripChapterNumber(chapter.title).trim() || chapter.title;
    return { title: cleanTitle, blocks };
  });

  return { intro, topics, words };
}

/** Render the complete guide PDF in memory. `logoBytes: null` skips the asset. */
export async function buildFullGuidePdf(
  input: FullGuidePdfInput,
  options: { logoBytes?: Uint8Array | null } = {},
): Promise<Uint8Array> {
  const content = fullGuideContent(input);
  return buildGuidePdf(
    {
      id: `full-${input.guide.id}`,
      bookTitle: input.bookTitle,
      subtitle: 'Full guide',
      intro: content.intro,
      topics: content.topics,
      generatedAt: input.generatedAt,
    },
    { logoBytes: options.logoBytes, pageBreakPerTopic: true },
  );
}

/** Build and write `Paths.cache/full-guide-<id>.pdf`, returning its shareable URI. */
export async function writeFullGuidePdf(input: FullGuidePdfInput): Promise<string> {
  const bytes = await buildFullGuidePdf(input);
  const safeId = input.guide.id.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const file = new File(Paths.cache, `full-guide-${safeId}.pdf`);
  if (file.exists) file.delete();
  file.create({ intermediates: true, overwrite: true });
  await file.write(bytes);
  return file.uri;
}
