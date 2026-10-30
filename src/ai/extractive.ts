/**
 * Offline extractive provider.
 *
 * This is the always-available floor: no network, no key, no model. It selects
 * real sentences from the supplied sources, so every answer is grounded by
 * construction. When asked something the sources do not cover it abstains
 * rather than guessing.
 */

import { ABSTAIN_TEXT, type AiProvider, type AiRequest, type AiResponse } from './types';
import {
  extractiveSummary,
  splitSentences,
  tokenize,
  topKeywords,
  truncate,
  wordCount,
} from '@/domain/text';
import { bm25 } from '@/domain/retrieval';
import type { Citation } from '@/domain/types';

const sentencePool = (request: AiRequest) =>
  request.sources.flatMap((source) =>
    splitSentences(source.text).map((sentence) => ({ sentence, source })),
  );

function cite(sentence: string, source: AiRequest['sources'][number]): Citation {
  return {
    chunkId: source.chunkId,
    bookId: '',
    page: source.page ?? null,
    sectionTitle: source.sectionTitle ?? null,
    quote: truncate(sentence, 320),
  };
}

function lengthToSentences(length: AiRequest['length']): number {
  if (length === 'short') return 4;
  if (length === 'long') return 10;
  return 6;
}

type NoteItem = {
  text: string;
  source: AiRequest['sources'][number];
  order: number;
};

/** Split every source into sentences and rank by overlap with the book keywords. */
function noteItems(request: AiRequest, limit: number): NoteItem[] {
  const joined = request.sources.map((source) => source.text).join('\n\n');
  const keywords = new Set(topKeywords(joined, 20));
  let order = 0;
  const pool = request.sources.flatMap((source) =>
    splitSentences(source.text)
      .filter((sentence) => wordCount(sentence) >= 5)
      .map((sentence) => ({ text: sentence, source, order: order++ })),
  );
  if (!pool.length) return [];

  return pool
    .map((item) => ({
      ...item,
      score: tokenize(item.text).filter((token) => keywords.has(token)).length,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .sort((a, b) => a.order - b.order)
    .map(({ text, source, order: itemOrder }) => ({ text, source, order: itemOrder }));
}

/**
 * Grow an extractive summary until it meets 90% of the word budget, then keep
 * the selected sentences in their original order. Pure and bounded.
 */
export function extractiveToBudget(text: string, targetWords: number): string {
  const sentences = splitSentences(text);
  if (!sentences.length) return '';
  const goal = Math.max(1, Math.round(targetWords)) * 0.9;

  let selected: string[] = [];
  for (let count = 1; count <= sentences.length; count += 1) {
    selected = extractiveSummary(text, { maxSentences: count });
    if (wordCount(selected.join(' ')) >= goal) break;
  }
  return selected.join('\n\n');
}

export const extractiveProvider: AiProvider = {
  id: 'extractive',
  label: 'On-device extractive',
  async isAvailable() {
    return true;
  },
  async generate(request: AiRequest): Promise<AiResponse> {
    const citations: Citation[] = [];
    const push = (sentence: string, source: AiRequest['sources'][number]) => {
      if (!citations.some((c) => c.chunkId === source.chunkId && c.quote === truncate(sentence, 320))) {
        citations.push(cite(sentence, source));
      }
    };

    if (request.task === 'answer' || request.task === 'explain') {
      const query = request.query?.trim() ?? '';
      const pool = sentencePool(request);
      if (!query || !pool.length) {
        return { text: ABSTAIN_TEXT, citations: [], provider: this.id, degraded: true };
      }
      const ranked = bm25(
        query,
        pool.map((p, i) => ({ id: String(i), text: p.sentence })),
        { limit: 3 },
      );
      const top = ranked
        .map((r) => pool[Number(r.id)])
        .filter((p) => p && p.sentence.length > 24);
      if (!top.length) {
        return { text: ABSTAIN_TEXT, citations: [], provider: this.id, degraded: true };
      }
      top.forEach((p) => push(p.sentence, p.source));
      const body = top.map((p) => `“${p.sentence.trim()}”`).join('\n\n');
      const lead =
        request.task === 'explain'
          ? 'Here is the passage that best explains it:'
          : 'The source says:';
      return {
        text: `${lead}\n\n${body}\n\n_This answer is extracted directly from your document — no model was used._`,
        citations,
        provider: this.id,
        degraded: true,
      };
    }

    const joined = request.sources.map((s) => s.text).join('\n\n');
    if (!joined.trim()) {
      return { text: ABSTAIN_TEXT, citations: [], provider: this.id, degraded: true };
    }

    if (request.task === 'notes') {
      const notes = noteItems(request, 8);
      for (const note of notes) push(note.text, note.source);
      return {
        text: notes.map((note) => `[${note.source.chunkId}] ${note.text}`).join('\n'),
        citations,
        provider: this.id,
        degraded: true,
      };
    }

    if (request.task === 'outline') {
      const notes = noteItems(request, 9);
      if (!notes.length) {
        return { text: '', citations: [], provider: this.id, degraded: true };
      }

      const headings: string[] = [];
      for (const source of request.sources) {
        const title = source.sectionTitle?.trim();
        if (title && !headings.includes(title)) headings.push(title);
        if (headings.length === 3) break;
      }
      for (let index = headings.length; index < 3; index += 1) {
        headings.push(`Part ${index + 1}`);
      }

      const buckets: NoteItem[][] = [[], [], []];
      for (const note of notes) {
        const title = note.source.sectionTitle?.trim();
        let index = title ? headings.indexOf(title) : -1;
        if (index === -1 || buckets[index].length >= 3) {
          index = buckets.findIndex((bucket) => bucket.length < 3);
        }
        if (index === -1) break;
        buckets[index].push(note);
        push(note.text, note.source);
      }

      const text = headings
        .map((heading, index) => {
          const points = buckets[index].map((note) => `- ${note.text}`);
          return [`## ${heading}`, ...points].join('\n');
        })
        .join('\n\n');

      return { text, citations, provider: this.id, degraded: true };
    }

    if (request.task === 'script') {
      const targetWords = request.targetWords ?? 725;
      const text = extractiveToBudget(joined, targetWords);
      return {
        text,
        citations: [],
        provider: this.id,
        degraded: true,
        truncated: wordCount(text) < targetWords * 0.9,
      };
    }

    const sentences = extractiveSummary(joined, {
      maxSentences: lengthToSentences(request.length),
    });
    const bySentence = new Map(sentencePool(request).map((p) => [p.sentence, p.source]));
    for (const sentence of sentences) {
      const source = bySentence.get(sentence);
      if (source) push(sentence, source);
    }
    const keywords = topKeywords(joined, 8);

    if (request.task === 'takeaways') {
      return {
        text: sentences.map((s) => `- ${s}`).join('\n'),
        citations,
        provider: this.id,
        degraded: true,
      };
    }

    if (request.task === 'lesson') {
      const bullets = sentences.map((s) => `- ${s}`).join('\n');
      const practice = keywords[0]
        ? `In your own words, explain **${keywords[0]}** and give one example from the source.`
        : 'In your own words, summarise the main argument of this passage.';
      return {
        text: `### Why this matters\n\n${sentences[0] ?? ''}\n\n### Key ideas\n\n${bullets}\n\n### Practice\n\n${practice}`,
        citations,
        provider: this.id,
        degraded: true,
      };
    }

    const thesis = sentences[0] ?? '';
    const rest = sentences.slice(1);
    return {
      text: `${thesis}\n\n${rest.map((s) => `- ${s}`).join('\n')}\n\n_Extracted on device from ${request.sources.length} passages._`,
      citations,
      provider: this.id,
      degraded: true,
    };
  },
};
