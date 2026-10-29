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
import type { Chunk, SummaryKind } from '@/domain/types';

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

export async function loadSources(bookId: string, max = 12): Promise<SourceBundle> {
  const all = await listChunksForBook(bookId);
  const document = await getDocument(bookId);
  const sectionTitles = new Map<string, string>();
  if (document) {
    for (const section of await listSections(document.id)) {
      if (section.title) sectionTitles.set(section.id, section.title);
    }
  }
  const chosen = sampleChunks(all, max);
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
  const bundle = await loadSources(bookId, kind === 'takeaways' ? 8 : 12);
  if (!bundle.sources.length) throw new Error('This book has no extracted text yet. Open it once to finish indexing.');
  const provider = await resolveProvider();
  const response = await provider.generate({
    task: kind === 'lesson' ? 'lesson' : kind === 'takeaways' ? 'takeaways' : 'summary',
    sources: bundle.sources,
    length,
  });
  const title =
    kind === 'lesson' ? 'Lesson' : kind === 'takeaways' ? 'Key takeaways' : kind === 'concepts' ? 'Concepts' : 'Summary';
  const summary = await saveSummary({
    bookId,
    kind,
    title,
    bodyMd: response.text,
    provider: response.provider,
    model: response.model ?? null,
    sourceChunkIds: response.citations.map((c) => c.chunkId),
  });
  return { summaryId: summary.id, provider: response.provider, degraded: !!response.degraded };
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

  // Retrieve the most relevant passages for the question, then let the provider
  // answer only from those. 6 sources keeps prompts small and citations checkable.
  const { searchChunks } = await import('@/domain/retrieval');
  const hits = searchChunks(question, bundle.chunks, 6);
  const chosen = hits.length ? hits.map((h) => h.chunk) : bundle.chunks.slice(0, 6);

  const conversationId =
    input.conversationId ?? (await createConversation(input.bookId, question.slice(0, 60))).id;
  await addMessage(conversationId, 'user', question);

  const provider = await resolveProvider();
  const response = await provider.generate({
    task: 'answer',
    query: question,
    sources: chosen.map((c) => ({ chunkId: c.id, text: c.text, page: c.page })),
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
  const provider = await resolveProvider();
  const response = await provider.generate({
    task: 'summary',
    sources: chunks.slice(0, 12).map((c) => ({ chunkId: c.id, text: c.text, page: c.page })),
    length,
  });
  const summary = await saveSummary({
    bookId,
    kind: 'chapter',
    title: section.title ?? `Chapter ${section.ordinal + 1}`,
    bodyMd: response.text,
    provider: response.provider,
    model: response.model ?? null,
    sectionId,
    sourceChunkIds: response.citations.map((c) => c.chunkId),
  });
  return { summaryId: summary.id, provider: response.provider, degraded: !!response.degraded };
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
