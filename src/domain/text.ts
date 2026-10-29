/** Text utilities shared by imports, summarisation, retrieval and quizzes. */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'fig', 'no', 'vol',
  'ch', 'pp', 'ed', 'al', 'inc', 'ltd', 'co', 'dept', 'univ', 'approx', 'ca', 'cf',
]);

export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Sentence splitter that tolerates common abbreviations and decimals. */
export function splitSentences(text: string): string[] {
  const clean = normalizeWhitespace(text).replace(/\n+/g, ' ');
  if (!clean) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const next = clean[i + 1];
    if (next && next !== ' ' && next !== '"' && next !== "'" && next !== ')') continue;
    const before = clean.slice(Math.max(0, i - 12), i).toLowerCase();
    const lastWord = before.match(/([a-z.]+)$/)?.[1] ?? '';
    if (ch === '.' && (ABBREVIATIONS.has(lastWord) || /\d$/.test(before))) continue;
    const sentence = clean.slice(start, i + 1).trim();
    if (sentence) out.push(sentence);
    start = i + 1;
    while (clean[start] === ' ') start += 1;
    i = start - 1;
  }
  const tail = clean.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function wordCount(text: string): number {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

export function estimateReadingMinutes(words: number, wpm = 220): number {
  return Math.max(1, Math.round(words / wpm));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  // Prefer a word boundary; only cut mid-word when there is no boundary at all.
  return `${cut.slice(0, at > 0 ? at : max).trimEnd()}…`;
}

export type TextChunk = {
  text: string;
  ordinal: number;
  charStart: number;
  charEnd: number;
  page?: number | null;
};

/**
 * Split text into overlapping, paragraph-aware chunks. Chunks are the unit of
 * retrieval, summarisation and citation; offsets let the reader link back.
 */
export function chunkText(
  raw: string,
  options: { targetChars?: number; overlapChars?: number; page?: number | null } = {},
): TextChunk[] {
  const { targetChars = 900, overlapChars = 120, page = null } = options;
  const text = normalizeWhitespace(raw);
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: TextChunk[] = [];
  let cursor = 0;
  let buffer = '';
  let bufferStart = 0;

  const flush = () => {
    const value = buffer.trim();
    if (!value) return;
    const start = bufferStart + buffer.indexOf(value);
    chunks.push({
      text: value,
      ordinal: chunks.length,
      charStart: start,
      charEnd: start + value.length,
      page,
    });
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      cursor += paragraph.length + 2;
      continue;
    }
    const pieces = paragraph.length > targetChars * 1.6 ? splitSentences(paragraph) : [paragraph];
    for (const piece of pieces) {
      if (!buffer) bufferStart = cursor;
      if (buffer.length + piece.length + 2 > targetChars && buffer) {
        flush();
        bufferStart = Math.max(0, cursor - overlapChars);
        buffer = text.slice(bufferStart, cursor).slice(-overlapChars);
      }
      buffer = buffer ? `${buffer} ${piece}` : piece;
      cursor += piece.length + 1;
    }
    cursor += 2;
    if (buffer.length >= targetChars) flush();
  }
  flush();
  return chunks;
}

export const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also may might must shall will upon within without many much one two three first second new using used use`.split(
    /\s+/,
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

export function topKeywords(text: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/** Deterministic PRNG (mulberry32) so quizzes are reproducible in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(items: T[], count: number, rand: () => number): T[] {
  const copy = [...items];
  const out: T[] = [];
  while (copy.length && out.length < count) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
}

/**
 * Frequency/position-based extractive summariser. This is the offline floor:
 * no model, deterministic, and always grounded in the source sentences.
 */
export function extractiveSummary(
  text: string,
  options: { maxSentences?: number; seed?: number } = {},
): string[] {
  const { maxSentences = 5 } = options;
  const sentences = splitSentences(text).filter((s) => wordCount(s) >= 6);
  if (sentences.length <= maxSentences) return sentences;

  const freq = new Map<string, number>();
  for (const token of tokenize(text)) freq.set(token, (freq.get(token) ?? 0) + 1);

  const scored = sentences.map((sentence, index) => {
    const tokens = tokenize(sentence);
    if (!tokens.length) return { sentence, index, score: 0 };
    const sum = tokens.reduce((acc, t) => acc + (freq.get(t) ?? 0), 0);
    const density = sum / Math.sqrt(tokens.length);
    const positionBonus = index < 3 ? 1.15 : 1;
    const lengthPenalty = tokens.length > 45 ? 0.85 : 1;
    return { sentence, index, score: density * positionBonus * lengthPenalty };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);
}

/** Pull definition-like sentences ("X is ...", "X refers to ..."). */
export function extractDefinitions(text: string, limit = 6): { term: string; definition: string }[] {
  const out: { term: string; definition: string }[] = [];
  for (const sentence of splitSentences(text)) {
    const m = sentence.match(
      /^([A-Z][\p{L}\p{N} \-]{2,40}?)\s+(?:is|are|refers to|means|describes|denotes)\s+(.{12,240})$/u,
    );
    if (m) {
      out.push({ term: m[1].trim(), definition: sentence.trim() });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Normalise for storage in FTS/LIKE comparisons. */
export function searchKey(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}
