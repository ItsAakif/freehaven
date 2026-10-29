/**
 * Deterministic card generation from source text.
 *
 * Cards carry `sourceChunkId` so every question can be traced back to the
 * passage it came from. Generation never invents facts: both sides come from
 * the same sentence(s).
 */

import { pick, seededRandom, splitSentences, topKeywords, truncate, wordCount } from './text';
import type { CardKind } from './types';

export type GeneratedCard = {
  front: string;
  back: string;
  kind: CardKind;
  options?: string[];
  answer?: string;
  explanation?: string;
  sourceChunkId: string;
};

type SourceChunk = { id: string; text: string; page?: number | null };

const DEFINITION = /^([A-Z][\p{L}\p{N} \-]{2,40}?)\s+(?:is|are|refers to|means|describes|denotes)\s+(.{12,240})$/u;

function cleanTerm(term: string): string {
  return term.replace(/^(the|a|an)\s+/i, '').trim();
}

export function generateCards(
  chunks: SourceChunk[],
  options: { maxCards?: number; seed?: number } = {},
): GeneratedCard[] {
  const { maxCards = 12, seed = 7 } = options;
  const rand = seededRandom(seed);
  const out: GeneratedCard[] = [];
  const seen = new Set<string>();

  // Pass 1: definition-style cards, which make the best questions.
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const m = sentence.match(DEFINITION);
      if (!m) continue;
      const term = cleanTerm(m[1]);
      const key = term.toLowerCase();
      if (!term || term.length < 3 || seen.has(key)) continue;
      seen.add(key);
      out.push({
        front: `What does the text say about “${truncate(term, 48)}”?`,
        back: sentence.trim(),
        kind: 'basic',
        sourceChunkId: chunk.id,
        explanation: `From the source: “${truncate(sentence.trim(), 220)}”`,
      });
      if (out.length >= maxCards) return out;
    }
  }

  // Pass 2: cloze cards from information-dense sentences.
  const candidates: { sentence: string; chunkId: string; term: string }[] = [];
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      if (wordCount(sentence) < 8 || wordCount(sentence) > 48) continue;
      const terms = topKeywords(sentence, 3);
      const term = terms.find((t) => sentence.toLowerCase().includes(t) && t.length >= 4);
      if (!term) continue;
      candidates.push({ sentence, chunkId: chunk.id, term });
    }
  }

  for (const candidate of candidates) {
    if (out.length >= maxCards) break;
    const key = candidate.sentence.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const blanked = candidate.sentence.replace(
      new RegExp(`\\b${candidate.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
      '_____',
    );
    if (blanked === candidate.sentence) continue;
    out.push({
      front: blanked,
      back: candidate.term,
      kind: 'basic',
      sourceChunkId: candidate.chunkId,
      explanation: `Complete sentence: “${candidate.sentence}”`,
    });
  }

  // Pass 3: multiple choice from the collected terms, when we have enough.
  const terms = [...new Set(candidates.map((c) => c.term))].filter((t) => t.length >= 4);
  if (terms.length >= 4) {
    for (const candidate of candidates) {
      if (out.length >= maxCards) break;
      const distractors = pick(terms.filter((t) => t !== candidate.term), 3, rand);
      if (distractors.length < 3) break;
      const options = pick([candidate.term, ...distractors], 4, rand);
      const blanked = candidate.sentence.replace(
        new RegExp(`\\b${candidate.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
        '_____',
      );
      out.push({
        front: `Which word completes this passage?\n\n${truncate(blanked, 260)}`,
        back: candidate.term,
        kind: 'mcq',
        options,
        answer: candidate.term,
        sourceChunkId: candidate.chunkId,
        explanation: `Complete sentence: “${candidate.sentence}”`,
      });
    }
  }

  return out.slice(0, maxCards);
}

/** Validate a user-edited MCQ before saving. */
export function isValidMcq(options: string[] | null | undefined, answer: string | null | undefined): boolean {
  return !!options && options.length >= 2 && !!answer && options.includes(answer);
}

export function cardFromManualInput(
  front: string,
  back: string,
  extra: Partial<GeneratedCard> = {},
): GeneratedCard | null {
  const f = front.trim();
  const b = back.trim();
  if (!f || !b) return null;
  return { front: f, back: b, kind: 'basic', sourceChunkId: extra.sourceChunkId ?? '', ...extra };
}

/** Terms used by the review UI to show topic mastery. */
export function cardKeywords(cards: { front: string; back: string }[], limit = 8): string[] {
  return topKeywords(cards.map((c) => `${c.front} ${c.back}`).join(' '), limit);
}
