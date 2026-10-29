import { extractiveProvider } from '@/ai/extractive';
import { ABSTAIN_TEXT, type AiRequest } from '@/ai/types';
import {
  OpenAiCompatibleProvider,
  buildUserPrompt,
  filterValidCitations,
  parseModelJson,
} from '@/ai/remote';

const sources: AiRequest['sources'] = [
  {
    chunkId: 'c1',
    text: 'Compound interest is the addition of interest to the principal sum of a loan or deposit. It is the result of reinvesting interest rather than paying it out.',
    page: 4,
  },
  {
    chunkId: 'c2',
    text: 'Spaced repetition strengthens long-term memory by reviewing material at increasing intervals.',
    page: 9,
  },
];

const answerRequest: AiRequest = { task: 'answer', query: 'What is compound interest?', sources };

describe('extractive provider', () => {
  it('answers with a citation drawn from the source', async () => {
    const response = await extractiveProvider.generate(answerRequest);
    expect(response.provider).toBe('extractive');
    expect(response.citations.length).toBeGreaterThan(0);
    const ids = new Set(sources.map((s) => s.chunkId));
    for (const citation of response.citations) expect(ids.has(citation.chunkId)).toBe(true);
    expect(response.text.toLowerCase()).toContain('interest');
  });

  it('abstains when the sources do not cover the question', async () => {
    const response = await extractiveProvider.generate({
      ...answerRequest,
      query: 'quantum chromodynamics lattice spacing',
    });
    expect(response.text).toBe(ABSTAIN_TEXT);
    expect(response.citations).toHaveLength(0);
  });

  it('produces a structured lesson with a practice prompt', async () => {
    const response = await extractiveProvider.generate({ task: 'lesson', sources });
    expect(response.text).toContain('### Key ideas');
    expect(response.text).toContain('### Practice');
    expect(response.citations.length).toBeGreaterThan(0);
  });
});

describe('remote provider', () => {
  it('parses fenced JSON and filters citations to retrieved chunks', () => {
    const raw = '```json\n{"answer":"It grows.","citations":[{"chunkId":"c1","quote":"Compound interest is the addition of interest"},{"chunkId":"ghost","quote":"made up"}]}\n```';
    const parsed = parseModelJson(raw);
    expect(parsed.answer).toBe('It grows.');
    const valid = filterValidCitations(parsed.citations, sources);
    expect(valid).toHaveLength(1);
    expect(valid[0].chunkId).toBe('c1');
  });

  it('builds a prompt that numbers sources and asks for JSON', () => {
    const prompt = buildUserPrompt(answerRequest);
    expect(prompt).toContain('chunkId=c1');
    expect(prompt).toContain('What is compound interest?');
  });

  it('returns model text with verified citations on success', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: 'Compound interest is interest on interest.',
                    citations: [{ chunkId: 'c1', quote: 'Compound interest is the addition of interest' }],
                  }),
                },
              },
            ],
          }),
        }) as unknown as Response,
    });
    const response = await provider.generate(answerRequest);
    expect(response.provider).toBe('openai-compatible');
    expect(response.degraded).toBeFalsy();
    expect(response.citations[0].chunkId).toBe('c1');
  });

  it('downgrades to the extractive path when the model fabricates citations', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: 'Invented claim.',
                    citations: [{ chunkId: 'does-not-exist', quote: 'nope' }],
                  }),
                },
              },
            ],
          }),
        }) as unknown as Response,
    });
    const response = await provider.generate(answerRequest);
    expect(response.degraded).toBe(true);
    expect(response.provider).toBe('extractive');
    expect(response.text).not.toBe('Invented claim.');
  });

  it('falls back on network failure and surfaces the reason', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const response = await provider.generate(answerRequest);
    expect(response.degraded).toBe(true);
    expect(response.text).toMatch(/Remote model unavailable/);
    expect(response.text).toContain('interest');
  });

  it('is unavailable without a key', async () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://x.test', model: 'm', apiKey: '' });
    expect(await provider.isAvailable()).toBe(false);
  });
});
