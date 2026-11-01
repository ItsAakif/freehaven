/**
 * High-level learning actions that combine retrieval, a provider and storage.
 * Screens call these; they never talk to a model directly.
 */

import { resolveProvider } from '@/ai';
import type { AiRequest, GroundedSource } from '@/ai/types';
import { addHighlight, listChunksForBook, listSections, getDocument } from '@/data/repositories/reading';
import { addCards, saveSummary } from '@/data/repositories/learning';
import { addMessage, createConversation } from '@/data/repositories/mindspace';
import { generateCards } from '@/domain/quiz';
import { conceptsToMarkdown, extractConcepts } from '@/domain/concepts';
import { searchChunks } from '@/domain/retrieval';
import type { Chunk, SummaryKind } from '@/domain/types';
import { lengthToWords, summariseBookDeep } from './summarise';

export type SourceBundle = {
  sources: GroundedSource[];
  chunks: Chunk[];
  coverage: { totalChunks: number; usedChunks: number };
};

/** Evenly sample chunks so a summary covers the whole document, not just page 1. */
export function sampleChunks(chunks: Chunk[], max = 12): Chunk[] {
  if (chunks.length <= max) return chunks;
  const step = (chunks.length - 1) / (max - 1);
  const picked: Chunk[] = [];
  for (let i = 0; i < max; i += 1) picked.push(chunks[Math.round(i * step)]);
  return picked.filter(Boolean);
}

const WHOLE_BOOK_TOPIC =
  /\b(main|overall|central|core|thesis|argument|premise|(?:big|key) ideas?|message|about|summary|summari[sz]e|what is this book|whole book|entire book)\b/i;
/** Same list without "about", which is only meaningful in "what is the book about?". */
const WHOLE_BOOK_SUBJECT =
  /\b(main|overall|central|core|thesis|argument|premise|(?:big|key) ideas?|message|summary|summari[sz]e|what is this book|whole book|entire book)\b/i;
const BOOK_REFERENCE = /\b(book|author|text|it)\b/i;
const BARE_WHOLE_BOOK_PHRASE =
  /\b(?:main|overall|central|core)\s+(?:argument|thesis|premise|ideas?|message)\b|\b(?:big|key)\s+ideas?\b|\bthesis\b/i;
/** A question about one chapter or passage is not a question about the book. */
const LOCAL_SCOPE = /\b(?:chapter|section|passage|page|paragraph)\b/i;
/** ...unless it names the whole book explicitly ("chapter by chapter", "as a whole"). */
const EXPLICIT_WHOLE_SCOPE =
  /\b(?:whole|entire)\s+(?:book|text)\b|\bas a whole\b|\b(?:chapter|section)\s+by\s+(?:chapter|section)\b/i;

/** "about" introduces the book itself only in "what is the book about?". */
function asksWhatBookIsAbout(question: string): boolean {
  return (
    /\bwhat(?:'s| is| are)\b[^.?!]*\babout\b/i.test(question) ||
    /\babout\s+(?:this|the)\s+(?:whole\s+|entire\s+)?book\b/i.test(question)
  );
}

/**
 * Does the question ask about the book as a whole (thesis, overall argument,
 * summary) rather than about one topic inside it?
 *
 * Precision matters more than recall here: a false positive replaces normal
 * retrieval with sampled passages for a question that wanted one passage, while
 * a false negative simply falls back to BM25.
 */
export function wholeBookIntent(question: string): boolean {
  const q = question.trim();
  if (!q || !WHOLE_BOOK_TOPIC.test(q)) return false;
  if (!BOOK_REFERENCE.test(q) && !BARE_WHOLE_BOOK_PHRASE.test(q)) return false;
  // "What is the main argument of chapter 3?" wants that chapter's argument,
  // not six passages sampled from the book's start, middle and end.
  if (LOCAL_SCOPE.test(q) && !EXPLICIT_WHOLE_SCOPE.test(q)) return false;
  // "what does the book say about risk?" is a specific-topic question even
  // though it contains both "book" and "about".
  return WHOLE_BOOK_SUBJECT.test(q) || asksWhatBookIsAbout(q);
}

/** Nearest unused chunk to `ideal`; prefers a section other than the previous pick. */
function nearestFreshChunk(
  ordered: Chunk[],
  ideal: number,
  used: Set<string>,
  previousSectionId: string | null,
): Chunk {
  let fallback: Chunk | null = null;
  for (let radius = 0; radius < ordered.length; radius += 1) {
    const indexes = radius === 0 ? [ideal] : [ideal - radius, ideal + radius];
    for (const index of indexes) {
      const candidate = ordered[index];
      if (!candidate || used.has(candidate.id)) continue;
      if (candidate.sectionId !== previousSectionId) {
        used.add(candidate.id);
        return candidate;
      }
      if (!fallback) fallback = candidate;
    }
  }
  const pick = fallback ?? ordered.find((chunk) => !used.has(chunk.id))!;
  used.add(pick.id);
  return pick;
}

/**
 * Sample chunks evenly across the book (start, middle, end) for whole-book
 * questions. Adjacent picks prefer a different section, so six passages are not
 * six paragraphs from one chapter. The result stays in book order and never
 * repeats a chunk.
 */
export function coverageChunks(chunks: Chunk[], limit = 6): Chunk[] {
  const seen = new Set<string>();
  const ordered = chunks
    .filter((chunk) => {
      if (seen.has(chunk.id)) return false;
      seen.add(chunk.id);
      return true;
    })
    .sort((a, b) => a.ordinal - b.ordinal);
  const count = Math.max(0, Math.floor(limit));
  if (!count || !ordered.length) return [];
  if (ordered.length <= count) return ordered;
  if (count === 1) return [ordered[0]];

  const step = (ordered.length - 1) / (count - 1);
  const used = new Set<string>();
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  // Pin the endpoints so "start" and "end" are always represented; only the
  // middle picks trade position for a fresh section.
  used.add(first.id);
  used.add(last.id);
  const picks: Chunk[] = [first];

  for (let i = 1; i < count - 1; i += 1) {
    const previous = picks[picks.length - 1];
    picks.push(nearestFreshChunk(ordered, Math.round(i * step), used, previous.sectionId ?? null));
  }

  picks.push(last);
  return picks.sort((a, b) => a.ordinal - b.ordinal);
}

const COVERAGE_INSTRUCTION =
  'These passages are sampled from across the whole book (beginning, middle and end). Answer at that level, and say so if the passages disagree.';

export async function loadSources(bookId: string, max = 12): Promise<SourceBundle> {
  return buildSourceBundle(bookId, max);
}

/** Every chunk in reading order — the deep summariser must see the whole book. */
export async function loadAllSources(bookId: string): Promise<SourceBundle> {
  return buildSourceBundle(bookId);
}

async function buildSourceBundle(bookId: string, max?: number): Promise<SourceBundle> {
  const all = await listChunksForBook(bookId);
  const document = await getDocument(bookId);
  const sectionTitles = new Map<string, string>();
  if (document) {
    for (const section of await listSections(document.id)) {
      if (section.title) sectionTitles.set(section.id, section.title);
    }
  }
  const chosen = max === undefined ? all : sampleChunks(all, max);
  return {
    chunks: chosen,
    coverage: { totalChunks: all.length, usedChunks: chosen.length },
    sources: chosen.map((c) => ({
      chunkId: c.id,
      text: c.text,
      page: c.page,
      sectionTitle: c.sectionId ? (sectionTitles.get(c.sectionId) ?? null) : null,
    })),
  };
}

export async function summariseBook(
  bookId: string,
  kind: SummaryKind = 'summary',
  length: AiRequest['length'] = 'medium',
): Promise<{ summaryId: string; provider: string; degraded: boolean }> {
  const bundle = await loadAllSources(bookId);
  if (!bundle.sources.length) throw new Error('This book has no extracted text yet. Open it once to finish indexing.');
  const result = await summariseBookDeep({
    bookId,
    kind,
    targetWords: lengthToWords(length),
  });
  if (!result.summaryId) throw new Error('Summary could not be saved.');
  return { summaryId: result.summaryId, provider: result.provider, degraded: result.degraded };
}

export async function generateCardsForBook(bookId: string, max = 12): Promise<number> {
  const bundle = await loadSources(bookId, 20);
  if (!bundle.chunks.length) throw new Error('Import or open a book first.');
  const generated = generateCards(bundle.chunks.map((c) => ({ id: c.id, text: c.text, page: c.page })), {
    maxCards: max,
  });
  if (!generated.length) throw new Error('Not enough clear statements to build cards from this text.');
  return addCards(bookId, generated);
}

export async function askBook(input: {
  bookId: string;
  question: string;
  conversationId?: string | null;
}): Promise<{ conversationId: string; answer: string; citations: { chunkId: string; quote: string; page?: number | null }[]; degraded: boolean }> {
  const question = input.question.trim();
  if (!question) throw new Error('Ask a question first.');
  const bundle = await loadSources(input.bookId, 40);
  if (!bundle.sources.length) throw new Error('This book has no indexed text yet.');

  // Whole-book questions get an even sample across the book; targeted questions
  // use BM25 and only fall back to sampling when nothing matched. 6 sources
  // keeps prompts small and every citation checkable against a real chunk id.
  let chosen: Chunk[];
  let coverage = wholeBookIntent(question);
  if (coverage) {
    chosen = coverageChunks(bundle.chunks, 6);
  } else {
    const hits = searchChunks(question, bundle.chunks, 6);
    if (hits.length) {
      chosen = hits.map((h) => h.chunk);
    } else {
      chosen = coverageChunks(bundle.chunks, 6);
      coverage = true;
    }
  }

  const conversationId =
    input.conversationId ?? (await createConversation(input.bookId, question.slice(0, 60))).id;
  await addMessage(conversationId, 'user', question);

  const provider = await resolveProvider();
  const response = await provider.generate({
    task: 'answer',
    query: question,
    sources: chosen.map((c) => ({ chunkId: c.id, text: c.text, page: c.page })),
    instruction: coverage ? COVERAGE_INSTRUCTION : undefined,
  });

  await addMessage(conversationId, 'assistant', response.text, response.citations);
  return {
    conversationId,
    answer: response.text,
    citations: response.citations.map((c) => ({ chunkId: c.chunkId, quote: c.quote, page: c.page })),
    degraded: !!response.degraded,
  };
}

export async function summariseChapter(
  bookId: string,
  sectionId: string,
  length: AiRequest['length'] = 'medium',
): Promise<{ summaryId: string; provider: string; degraded: boolean }> {
  const document = await getDocument(bookId);
  if (!document) throw new Error('This book has no extracted text yet.');
  const sections = await listSections(document.id);
  const section = sections.find((s) => s.id === sectionId);
  if (!section) throw new Error('That chapter is no longer available.');
  const chunks = (await listChunksForBook(bookId)).filter((c) => c.sectionId === sectionId);
  if (!chunks.length) throw new Error('No indexed text was found for that chapter.');
  const result = await summariseBookDeep({
    bookId,
    kind: 'chapter',
    targetWords: lengthToWords(length),
    sectionId,
    title: section.title ?? `Chapter ${section.ordinal + 1}`,
  });
  if (!result.summaryId) throw new Error('Chapter summary could not be saved.');
  return { summaryId: result.summaryId, provider: result.provider, degraded: result.degraded };
}

/** Definition-style concepts, extracted locally — no model involved. */
export async function conceptSummary(bookId: string): Promise<{ summaryId: string; count: number }> {
  const chunks = await listChunksForBook(bookId);
  const concepts = extractConcepts(
    chunks.map((c) => ({ id: c.id, text: c.text })),
    15,
  );
  if (!concepts.length) {
    throw new Error('No definition-style statements were found in this text.');
  }
  const summary = await saveSummary({
    bookId,
    kind: 'concepts',
    title: 'Concepts',
    bodyMd: conceptsToMarkdown(concepts),
    provider: 'extractive-local',
    sourceChunkIds: [...new Set(concepts.map((c) => c.chunkId))],
  });
  return { summaryId: summary.id, count: concepts.length };
}

/** Keep the best sentence of an AI answer as a source-linked highlight. */
export async function saveAnswerAsHighlight(bookId: string, quote: string, note: string): Promise<void> {
  await addHighlight({ bookId, locator: 'ai', quote, note, color: 'gold' });
}
