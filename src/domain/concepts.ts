import { extractDefinitions } from './text';

export type Concept = { term: string; definition: string; chunkId: string };

/** Pull definition-like statements from chunks, de-duplicated by term. */
export function extractConcepts(chunks: { id: string; text: string }[], limit = 12): Concept[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const out: Concept[] = [];
  for (const chunk of chunks) {
    for (const found of extractDefinitions(chunk.text, limit)) {
      const key = found.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ term: found.term, definition: found.definition, chunkId: chunk.id });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function conceptsToMarkdown(concepts: Concept[]): string {
  if (!concepts.length) return '';
  return concepts.map((c) => `**${c.term}** — ${c.definition}`).join('\n\n');
}
