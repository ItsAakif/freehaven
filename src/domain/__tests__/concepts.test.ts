import { conceptsToMarkdown, extractConcepts } from '@/domain/concepts';

describe('concept extraction', () => {
  it('finds definition-style statements and keeps their chunk id', () => {
    const concepts = extractConcepts([
      { id: 'c1', text: 'Compound interest is the addition of interest to the principal sum.' },
      { id: 'c2', text: 'Spaced repetition means reviewing material at increasing intervals. It works.' },
    ]);
    expect(concepts.map((c) => c.term)).toEqual(['Compound interest', 'Spaced repetition']);
    expect(concepts[0].chunkId).toBe('c1');
    expect(concepts[1].chunkId).toBe('c2');
  });

  it('de-duplicates terms and honours the limit', () => {
    const text = 'Attention is the selective allocation of processing resources.';
    const concepts = extractConcepts([
      { id: 'c1', text },
      { id: 'c2', text },
    ]);
    expect(concepts).toHaveLength(1);
    expect(extractConcepts([{ id: 'c1', text }], 0)).toHaveLength(0);
  });

  it('renders markdown and handles no concepts', () => {
    expect(conceptsToMarkdown([])).toBe('');
    const md = conceptsToMarkdown([{ term: 'Habit', definition: 'Habit is a routine.', chunkId: 'c1' }]);
    expect(md).toContain('**Habit**');
  });
});
